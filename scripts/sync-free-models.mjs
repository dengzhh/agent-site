#!/usr/bin/env node
// 同步免费模型数据：models.dev 主源 + OpenRouter 官方 API 交叉校验。
// 纯函数 buildFreeModelsIndex 供 vitest 测试；main() 仅做 fetch/落盘。
import { writeFileSync, renameSync, readFileSync } from 'node:fs';

export const PROVIDER_ALLOWLIST = [
  'openrouter', 'nvidia', 'groq', 'mistral', 'cerebras', 'zai',
  'github-copilot', 'cloudflare-workers-ai', 'alibaba-token-plan',
  'opencode', 'deepinfra', 'togetherai', 'fireworks-ai',
];

// models.dev 不携带的 provider 级补充信息（Anthropic 兼容端点、免费档限流说明）
// groq 补 OpenAI 兼容端点：models.dev 无 api 字段，而其免费模型不在下游工具的
// 静态目录里，需要 baseUrl 才能走动态回退（Chat 抽屉场景）
export const PROVIDER_OVERRIDES = {
  zai: { anthropicApi: 'https://api.z.ai/api/anthropic' },
  openrouter: { note: 'Free models are rate-limited: ~20 req/min with a $10 credit, 50 requests/day without.' },
  opencode: { note: 'Free models on the Zen endpoint — requires a (free) OpenCode API key; get one at opencode.ai.' },
  groq: { api: 'https://api.groq.com/openai/v1' },
};

// ── Pricing index（成本计算器数据）：三家主流 provider 的有价文本模型 ──
const PRICING_PROVIDERS = ['anthropic', 'openai', 'google'];
const NON_TEXT = /image|tts|stt|embed|veo|lyria|omni|realtime|computer-use|deep-research/i;

export function buildPricingIndex(modelsdev) {
  const providers = [];
  let count = 0;
  for (const pid of PRICING_PROVIDERS) {
    const p = modelsdev[pid];
    if (!p?.models) continue;
    const models = Object.values(p.models)
      .filter((m) =>
        m.cost?.input != null && m.cost?.output != null &&
        (m.limit?.context ?? 0) >= 32000 &&
        !NON_TEXT.test(m.id ?? '') )
      .map((m) => ({
        id: m.id,
        label: m.name ?? m.id,
        context: m.limit?.context ?? 0,
        input: m.cost.input,
        output: m.cost.output,
        cacheRead: m.cost.cache_read ?? null,
        cacheWrite: m.cost.cache_write ?? null,
      }))
      .sort((a, b) => b.context - a.context || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)); // context 降序；同 context 按 id 降序 → 输出顺序确定，上游插入序变化不会产生噪声 diff
    if (models.length === 0) continue;
    count += models.length;
    providers.push({ id: pid, name: p.name || pid, models });
  }
  if (count === 0) throw new Error('no priced models extracted — refusing to write pricing index');
  return { syncedAt: new Date().toISOString(), source: 'models.dev', providers };
}

const trim = (m) => ({
  id: m.id,
  name: m.name,
  context: m.limit?.context ?? 0,
  maxOutput: m.limit?.output ?? 0,
  toolCall: m.tool_call === true,
  reasoning: m.reasoning === true,
  attachment: m.attachment === true,
  openWeights: m.open_weights === true,
  lastUpdated: m.last_updated ?? null,
});

export function buildFreeModelsIndex(modelsdev, openrouterApi) {
  const orFreeIds = new Set(
    (openrouterApi?.data ?? []).map((m) => m.id).filter((id) => id.endsWith(':free')),
  );
  const providers = [];
  let totalFree = 0;

  for (const pid of PROVIDER_ALLOWLIST) {
    const p = modelsdev[pid];
    if (!p?.models) continue;
    let models = Object.values(p.models)
      .filter((m) => m.id != null) // models.dev 偶见无 id 条目，直接跳过
      .filter((m) => m.cost?.input === 0 && m.cost?.output === 0)
      .map(trim)
      .sort((a, b) => (b.context || 0) - (a.context || 0));
    // 零付费模型一个都没有 → provider 整个不出现（在交叉校验前判断）
    if (models.length === 0) continue;
    if (pid === 'openrouter' && openrouterApi !== null) {
      // openrouterApi === null 表示官方 API 拉取失败（main 里已降级），此时保留主源数据。
      // 已知漏收：OpenRouter 上确有 4 个零价但 id 不带 :free 后缀的模型会被此过滤掉——
      // openrouter/free、stealth/space-bunny-alpha、google/lyria-*（见交叉源 api/v1/models）。
      models = models.filter((m) => orFreeIds.has(m.id));
    }
    // 校验源在线但过滤后为空 → 不留 0 模型的 provider 节
    if (models.length === 0) continue;
    totalFree += models.length;
    providers.push({
      id: pid,
      name: p.name || pid,
      api: p.api || null,
      envKey: p.env?.[0] || `${pid.toUpperCase().replace(/-/g, '_')}_API_KEY`,
      npm: p.npm || null,
      doc: p.doc || null,
      ...({ note: null, anthropicApi: null, ...PROVIDER_OVERRIDES[pid] }),
      models,
    });
  }

  return {
    syncedAt: new Date().toISOString(),
    source: 'models.dev + openrouter/api/v1/models',
    totalFree,
    providers,
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
  const modelsdev = await fetchJson('https://models.dev/api.json');
  let openrouterApi = null;
  try {
    openrouterApi = await fetchJson('https://openrouter.ai/api/v1/models');
  } catch (err) {
    console.warn('openrouter api unavailable, skipping cross-check:', err.message);
  }

  const before = Object.values(modelsdev).reduce(
    (n, p) => n + Object.keys(p.models || {}).length, 0);
  const idx = buildFreeModelsIndex(modelsdev, openrouterApi);

  // 防呆：上游 schema 崩坏时不要清空上线
  const kept = idx.totalFree;
  if (kept === 0) throw new Error('zero free models extracted — refusing to write empty index');
  console.log(`models seen: ${before}, free kept: ${kept}, providers: ${idx.providers.length}`);

  const outPath = new URL('../src/data/free-models.json', import.meta.url);
  // 噪声抑制：内容（除 syncedAt）与旧文件一致则不写盘，避免 Actions 提交时间戳噪声
  let freeChanged = true;
  try {
    const old = JSON.parse(readFileSync(outPath, 'utf8'));
    const { syncedAt: _old, ...oldRest } = old;
    const { syncedAt: _new, ...newRest } = idx;
    if (JSON.stringify(oldRest) === JSON.stringify(newRest)) {
      freeChanged = false;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('could not diff old index:', err.message);
  }
  if (freeChanged) {
    // 原子写：先写 tmp 再 rename，避免半截 JSON 被读到
    writeFileSync(new URL('../src/data/free-models.json.tmp', import.meta.url), JSON.stringify(idx, null, 2) + '\n');
    renameSync(new URL('../src/data/free-models.json.tmp', import.meta.url), outPath);
    console.log('wrote src/data/free-models.json');
  } else {
    console.log('free-models: no changes');
  }

  const pricing = buildPricingIndex(modelsdev);
  const pricingPath = new URL('../src/data/pricing.json', import.meta.url);
  let pricingChanged = true;
  try {
    const oldPricing = JSON.parse(readFileSync(pricingPath, 'utf8'));
    const { syncedAt: _o, ...oldRest } = oldPricing;
    const { syncedAt: _n, ...newRest } = pricing;
    pricingChanged = JSON.stringify(oldRest) !== JSON.stringify(newRest);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('pricing compare failed:', err.message);
  }
  if (pricingChanged) {
    // 原子写：先写 tmp 再 rename，避免半截 JSON 被读到
    writeFileSync(new URL('../src/data/pricing.json.tmp', import.meta.url), JSON.stringify(pricing, null, 2) + '\n');
    renameSync(new URL('../src/data/pricing.json.tmp', import.meta.url), pricingPath);
    console.log('wrote src/data/pricing.json');
  } else {
    console.log('pricing: no changes');
  }
  console.log(`pricing: providers ${pricing.providers.length}, priced models ${pricing.providers.reduce((n, p) => n + p.models.length, 0)}`);
}

if (process.argv[1] && process.argv[1].endsWith('sync-free-models.mjs')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
