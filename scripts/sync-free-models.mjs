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
export const PROVIDER_OVERRIDES = {
  zai: { anthropicApi: 'https://api.z.ai/api/anthropic' },
  openrouter: { note: 'Free models are rate-limited: ~20 req/min with a $10 credit, 50 requests/day without.' },
  opencode: { note: 'No account needed — the Zen endpoint serves free models without a key.' },
};

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
  try {
    const old = JSON.parse(readFileSync(outPath, 'utf8'));
    const { syncedAt: _old, ...oldRest } = old;
    const { syncedAt: _new, ...newRest } = idx;
    if (JSON.stringify(oldRest) === JSON.stringify(newRest)) {
      console.log('no changes');
      return;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('could not diff old index:', err.message);
  }
  // 原子写：先写 tmp 再 rename，避免半截 JSON 被读到
  writeFileSync(new URL('../src/data/free-models.json.tmp', import.meta.url), JSON.stringify(idx, null, 2) + '\n');
  renameSync(new URL('../src/data/free-models.json.tmp', import.meta.url), outPath);
  console.log('wrote src/data/free-models.json');
}

if (process.argv[1] && process.argv[1].endsWith('sync-free-models.mjs')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
