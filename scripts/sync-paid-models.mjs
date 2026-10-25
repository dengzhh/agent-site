#!/usr/bin/env node
// 同步付费热门模型榜：OpenRouter rankings（真实用量）× models api（价格/能力）。
// 纯函数 buildPaidBoard 供 vitest；main() 只做 fetch/落盘。
import { writeFileSync, renameSync, readFileSync } from 'node:fs';

const TOP_N = 30;
const RANKINGS_URL = 'https://openrouter.ai/api/frontend/v1/rankings/models';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';

// rankings 用带 -YYYYMMDD 后缀的 permaslug，models api 的 id 多数不带后缀
// （2026-10-24 实测：精确命中仅 20% 模型数 / 1.5% 用量；剥后缀兜底后覆盖 95.2%
// 用量）。热度必须按 resolve 出来的 models id 聚合——同族日期快照才会合并。
const stripDate = (s) => s.replace(/-[0-9]{8}$/, '');
export const resolveId = (slug, ids) => (ids.has(slug) ? slug : (ids.has(stripDate(slug)) ? stripDate(slug) : null));

export function buildPaidBoard(rankings, modelsApi, opts = {}) {
  const rows = Array.isArray(rankings?.data) ? rankings.data : [];
  const models = Array.isArray(modelsApi?.data) ? modelsApi.data : [];
  const byId = new Map(models.map((m) => [m.id, m]));

  // 1) 只取 standard；2) 聚合到 resolved id
  const heat = new Map(); // resolvedId -> {prompt, completion}
  const rawHeat = new Map(); // 原始 slug 总量（算覆盖率用，不能被 resolve 抬高）
  let standardRows = 0;
  for (const r of rows) {
    if (r?.variant !== 'standard' || !r?.model_permaslug) continue;
    standardRows += 1;
    // 上游把数值改成字符串（'100'）或缺字段时：?? 0 会漏、+ 会字符串拼接。
    // 统一 Number 化，非有限值按 0——坏一行不至于让整个榜单报废。
    const num = (v) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
    const pt = num(r.total_prompt_tokens), ct = num(r.total_completion_tokens);
    rawHeat.set(r.model_permaslug, (rawHeat.get(r.model_permaslug) ?? 0) + pt + ct);
    const id = resolveId(r.model_permaslug, byId);
    if (!id) continue;
    const acc = heat.get(id) ?? { prompt: 0, completion: 0 };
    acc.prompt += pt; acc.completion += ct;
    heat.set(id, acc);
  }

  // 用量覆盖率防线：rankings 大改版（字段改名/全零）时宁可同步失败，不悄悄发残榜。
  // standardRows>0 但 totalRaw===0（字段全改名）视同覆盖率 0。
  const totalRaw = [...rawHeat.values()].reduce((n, v) => n + v, 0);
  const joined = [...heat.values()].reduce((n, a) => n + a.prompt + a.completion, 0);
  const ratio = totalRaw > 0 ? joined / totalRaw : 0;
  if (standardRows > 0 && ratio < 0.5) {
    throw new Error(`join coverage ${(ratio * 100).toFixed(1)}% < 50% — upstream shape likely changed`);
  }

  // 3) 付费过滤 + canonical 去重（同族不同 id 留最热）
  const heatOf = (a) => a.prompt + a.completion;
  const byCanonical = new Map();
  for (const [id, h] of heat) {
    const m = byId.get(id);
    const pin = Number(m.pricing?.prompt ?? 0), pout = Number(m.pricing?.completion ?? 0);
    if (!(pin > 0 || pout > 0)) continue; // 付费榜：全零价归免费页
    const key = m.canonical_slug || id;
    const prev = byCanonical.get(key);
    if (!prev || heatOf(h) > heatOf(prev.heat)) byCanonical.set(key, { m, id, heat: h, pin, pout });
  }

  const candidates = [...byCanonical.values()]
    .sort((a, b) => heatOf(b.heat) - heatOf(a.heat) || (a.id < b.id ? -1 : 1));
  if (candidates.length === 0) throw new Error('zero paid models — refusing to write empty board');

  const perM = (v) => Number((Number(v) * 1e6).toPrecision(3));
  return {
    syncedAt: new Date().toISOString(),
    source: 'openrouter rankings + models api',
    windowDays: new Set(rows.map((r) => r.date)).size,
    totalCandidates: candidates.length,
    models: candidates.slice(0, opts.topN ?? TOP_N).map(({ m, id, heat: h, pin, pout }) => ({
      id,
      name: m.name ?? id,
      canonicalSlug: m.canonical_slug ?? null,
      heat: { promptTokens: h.prompt, completionTokens: h.completion },
      // 复用过滤时算好的 pin/pout：emission 直接读 m.pricing.prompt 在字段缺失时
      // 会产出 null（NaN 序列化），到构建期才炸、离病因很远。
      price: { input: perM(pin), output: perM(pout) },
      context: m.context_length ?? 0,
      maxOutput: m.top_provider?.max_completion_tokens ?? null,
      toolCall: (m.supported_parameters ?? []).includes('tools'),
      reasoning: (m.supported_parameters ?? []).includes('reasoning'),
      attachment: (m.architecture?.input_modalities ?? []).includes('image'),
      detailUrl: `https://openrouter.ai/${id}`,
    })),
  };
}

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 4 ** i));
    }
  }
}

async function main() {
  const [rankings, modelsApi] = await Promise.all([fetchJson(RANKINGS_URL), fetchJson(MODELS_URL)]);
  // stdout 记未关联上的 slug 数（设计文档 §4：join 健康度要在 Actions 日志里可见）
  const ids = new Set((modelsApi?.data ?? []).map((m) => m.id));
  let skipped = 0;
  for (const r of rankings?.data ?? []) {
    if (r?.variant !== 'standard' || !r?.model_permaslug) continue;
    if (!resolveId(r.model_permaslug, ids)) skipped += 1;
  }
  console.log(`skipped: ${skipped}`);
  const board = buildPaidBoard(rankings, modelsApi);
  console.log(`paid board: ${board.models.length} of ${board.totalCandidates} candidates, window ${board.windowDays}d`);
  console.log(`top: ${board.models.slice(0, 3).map((m) => `${m.id}(${((m.heat.promptTokens + m.heat.completionTokens) / 1e12).toFixed(1)}T)`).join(', ')}`);

  const outPath = new URL('../src/data/paid-models.json', import.meta.url);
  // 噪声抑制：除 syncedAt 外无变化则不写盘（与 sync-free-models 同策略）
  let changed = true;
  try {
    const old = JSON.parse(readFileSync(outPath, 'utf8'));
    const { syncedAt: _o, ...oldRest } = old;
    const { syncedAt: _n, ...newRest } = board;
    if (JSON.stringify(oldRest) === JSON.stringify(newRest)) changed = false;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('could not diff old board:', err.message);
  }
  if (changed) {
    writeFileSync(new URL('../src/data/paid-models.json.tmp', import.meta.url), JSON.stringify(board, null, 2) + '\n');
    renameSync(new URL('../src/data/paid-models.json.tmp', import.meta.url), outPath);
    console.log('wrote src/data/paid-models.json');
  } else {
    console.log('paid board: no changes');
  }
}

if (process.argv[1] && process.argv[1].endsWith('sync-paid-models.mjs')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
