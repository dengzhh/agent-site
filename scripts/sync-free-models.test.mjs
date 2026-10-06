import { describe, it, expect } from 'vitest';
import { buildFreeModelsIndex, buildPricingIndex, PROVIDER_ALLOWLIST } from './sync-free-models.mjs';

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
    // 校验源在线但没有任何 :free id → 模型清空，provider 整节不出现
    const idx2 = buildFreeModelsIndex(modelsdev, { data: [] });
    expect(idx2.providers.find((p) => p.id === 'openrouter')).toBeUndefined();
  });

  it('keeps openrouter main-source models when cross-check API is unavailable', () => {
    const idx = buildFreeModelsIndex(modelsdev, null); // OR API 故障 → 保留主源
    const or = idx.providers.find((p) => p.id === 'openrouter');
    expect(or.models.map((m) => m.id)).toEqual(['google/gemma:free']);
  });

  it('annotates agents: openrouter prefers cc, others pi', () => {
    // OpenRouter 免费模型受 agentic harness 限制，只有 cc 适配器能承载；其余走默认 pi
    const src = {
      ...md('openrouter', [model({ id: 'google/gemma:free' })]),
      ...md('groq', [model({ id: 'llama-free' })]),
    };
    const idx = buildFreeModelsIndex(src, orApi);
    const or = idx.providers.find((p) => p.id === 'openrouter');
    const groq = idx.providers.find((p) => p.id === 'groq');
    expect(or.models[0].agents).toEqual(['cc', 'pi']);
    expect(groq.models[0].agents).toEqual(['pi']);
  });

  it('annotates every surviving model, including the openrouter API-down path', () => {
    // 标注在 provider 循环内对过滤后的存活模型逐个施加：既覆盖交叉校验幸存者，
    // 也覆盖官方 API 拉取失败（null）时保留的主源模型。
    const src = {
      ...md('openrouter', [model({ id: 'a:free' }), model({ id: 'b:free' })]),
      ...md('nvidia', [model({ id: 'nemotron' })]),
    };
    const idx = buildFreeModelsIndex(src, { data: [{ id: 'a:free' }, { id: 'b:free' }] });
    const or = idx.providers.find((p) => p.id === 'openrouter');
    expect(or.models.map((m) => m.agents)).toEqual([['cc', 'pi'], ['cc', 'pi']]);

    const down = buildFreeModelsIndex(src, null);
    const orDown = down.providers.find((p) => p.id === 'openrouter');
    const nvDown = down.providers.find((p) => p.id === 'nvidia');
    expect(orDown.models.every((m) => m.agents?.[0] === 'cc')).toBe(true);
    expect(nvDown.models[0].agents).toEqual(['pi']);
  });

  it('trims fields and carries provider meta + overrides', () => {
    const idx = buildFreeModelsIndex(modelsdev, orApi);
    const zai = idx.providers.find((p) => p.id === 'zai');
    expect(zai.anthropicApi).toBe('https://api.z.ai/api/anthropic'); // 覆盖表注入
    expect(zai.models[0]).toEqual({
      id: 'glm-4.5-flash', name: 'Test Model', context: 100000, maxOutput: 8192,
      toolCall: true, reasoning: false, attachment: false, openWeights: false,
      lastUpdated: '2026-09-01', agents: ['pi'],
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
      'opencode', 'deepinfra', 'togetherai', 'fireworks-ai',
    ]);
  });
});

describe('buildPricingIndex', () => {
  const pricingSrc = {
    anthropic: {
      id: 'anthropic', name: 'Anthropic', env: [], npm: null,
      models: {
        'claude-opus-5-5': { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', limit: { context: 1000000, output: 64000 }, cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } },
        'claude-haiku-4-5': { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', limit: { context: 200000, output: 32000 }, cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 } },
        'claude-no-cache':  { id: 'claude-no-cache', name: 'No Cache', limit: { context: 200000, output: 32000 }, cost: { input: 2, output: 8 } },
      },
    },
    openai: {
      id: 'openai', name: 'OpenAI', env: [], npm: null,
      models: {
        'gpt-image-x': { id: 'gpt-image-x', name: 'Image X', limit: { context: 128000 }, cost: { input: 5, output: 20 } },
        'tiny-embed':  { id: 'tiny-embed', name: 'Embed', limit: { context: 8191 }, cost: { input: 0.02, output: 0 } },
        'gpt-5':       { id: 'gpt-5', name: 'GPT-5', limit: { context: 400000, output: 128000 }, cost: { input: 1.25, output: 10, cache_read: 0.125 } },
      },
    },
    google: {
      id: 'google', name: 'Google', env: [], npm: null,
      models: {
        'gemini-3-flash': { id: 'gemini-3-flash', name: 'Gemini 3 Flash', limit: { context: 1048576 }, cost: { input: 0.5, output: 3, cache_read: 0.05 } },
      },
    },
  };

  it('keeps priced text models, drops images/embeds/tiny-context', () => {
    const idx = buildPricingIndex(pricingSrc);
    const openai = idx.providers.find((p) => p.id === 'openai');
    expect(openai.models.map((m) => m.id)).toEqual(['gpt-5']);
  });

  it('maps fields with null cache defaults and sorts by context desc', () => {
    const idx = buildPricingIndex(pricingSrc);
    const anthropic = idx.providers.find((p) => p.id === 'anthropic');
    expect(anthropic.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-no-cache', 'claude-haiku-4-5']);
    expect(anthropic.models[1]).toEqual({
      id: 'claude-no-cache', label: 'No Cache', context: 200000,
      input: 2, output: 8, cacheRead: null, cacheWrite: null,
    });
  });

  it('covers exactly the three mainstream providers', () => {
    const idx = buildPricingIndex(pricingSrc);
    expect(idx.providers.map((p) => p.id)).toEqual(['anthropic', 'openai', 'google']);
  });

  it('throws on zero priced models (schema collapse guard)', () => {
    expect(() => buildPricingIndex({ anthropic: { id: 'anthropic', name: 'A', models: {} } }))
      .toThrow(/no priced models/i);
  });
});
