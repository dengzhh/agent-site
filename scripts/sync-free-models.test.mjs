import { describe, it, expect } from 'vitest';
import { buildFreeModelsIndex, PROVIDER_ALLOWLIST } from './sync-free-models.mjs';

// 与 models.dev api.json 同构的最小 fixture
const md = (pid, models, extra = {}) => ({
  [pid]: {
    id: pid, name: pid.toUpperCase(), env: ['X_API_KEY'],
    api: `https://${pid}.example/v1`, npm: '@ai-sdk/openai-compatible',
    ...extra,
    models: Object.fromEntries(models.map((m) => [m.id, m])),
  },
});
const model = (over = {}) => ({
  id: 'test/model', name: 'Test Model',
  limit: { context: 100000, output: 8192 },
  cost: { input: 0, output: 0 },
  tool_call: true, reasoning: false, attachment: false, open_weights: false,
  last_updated: '2026-09-01', ...over,
});

describe('buildFreeModelsIndex', () => {
  const modelsdev = {
    ...md('openrouter', [model({ id: 'google/gemma:free', name: 'Gemma (free)' }), model({ id: 'paid/model', cost: { input: 1, output: 2 } })]),
    ...md('zai', [model({ id: 'glm-4.5-flash' })]),
    ...md('mirror-hub', [model({ id: 'x/y' })]), // 白名单外
  };
  const orApi = { data: [{ id: 'google/gemma:free' }, { id: 'other/model:free' }] };

  it('keeps only allowlisted providers with zero-cost models', () => {
    const idx = buildFreeModelsIndex(modelsdev, orApi);
    const ids = idx.providers.map((p) => p.id);
    expect(ids).toContain('openrouter');
    expect(ids).toContain('zai');
    expect(ids).not.toContain('mirror-hub');
  });

  it('drops non-free models', () => {
    const idx = buildFreeModelsIndex(modelsdev, orApi);
    const or = idx.providers.find((p) => p.id === 'openrouter');
    expect(or.models.map((m) => m.id)).toEqual(['google/gemma:free']);
  });

  it('cross-checks openrouter ids against official API', () => {
    // google/gemma:free 在官方 API 中存在 → 保留
    const idx = buildFreeModelsIndex(modelsdev, orApi);
    const or = idx.providers.find((p) => p.id === 'openrouter');
    expect(or.models[0].id).toBe('google/gemma:free');
    // 官方 API 没有的 :free id → 丢弃
    const idx2 = buildFreeModelsIndex(modelsdev, { data: [] });
    const or2 = idx2.providers.find((p) => p.id === 'openrouter');
    expect(or2.models).toEqual([]);
  });

  it('trims fields and carries provider meta + overrides', () => {
    const idx = buildFreeModelsIndex(modelsdev, orApi);
    const zai = idx.providers.find((p) => p.id === 'zai');
    expect(zai.anthropicApi).toBe('https://api.z.ai/api/anthropic'); // 覆盖表注入
    expect(zai.models[0]).toEqual({
      id: 'glm-4.5-flash', name: 'Test Model', context: 100000, maxOutput: 8192,
      toolCall: true, reasoning: false, attachment: false, openWeights: false,
      lastUpdated: '2026-09-01',
    });
  });

  it('records counts and skips when nothing is free', () => {
    const idx = buildFreeModelsIndex({ ...md('openrouter', [model({ cost: { input: 1, output: 0 } })]) }, orApi);
    expect(idx.providers).toEqual([]); // 全付费 → provider 整个不出现
  });

  it('allowlist covers the 12 spec providers', () => {
    expect(PROVIDER_ALLOWLIST).toEqual([
      'openrouter', 'nvidia', 'groq', 'mistral', 'cerebras', 'zai',
      'github-copilot', 'cloudflare-workers-ai', 'alibaba-token-plan',
      'deepinfra', 'together', 'fireworks',
    ]);
  });
});
