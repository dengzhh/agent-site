import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { resolveModel, UnsupportedError } from '../src/providers.mjs';

// groq 是内置 provider：目录命中且无 baseUrl → 内置模型
test('builtin provider hit returns catalog model', () => {
  const models = createModels();
  const r = resolveModel(models, { provider: 'groq', model: 'llama-3.3-70b-versatile' });
  assert.equal(r.model.provider, 'groq');
  assert.equal(r.model.id, 'llama-3.3-70b-versatile');
});

// baseUrl 与目录不一致（如 zai 免费档走 paas 端点而非 coding 端点）→ 动态回退
test('baseUrl mismatch falls back to dynamic provider', () => {
  const models = createModels();
  const r = resolveModel(models, {
    provider: 'zai', model: 'glm-5.3-flash',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    envKey: 'ZHIPU_API_KEY', name: 'GLM 5.3 Flash',
    contextWindow: 128000, maxOutput: 8192,
  });
  assert.equal(r.model.api, 'openai-completions');
  assert.equal(r.model.baseUrl, 'https://api.z.ai/api/paas/v4');
  assert.equal(r.model.contextWindow, 128000);
});

// 无工厂且无 baseUrl（deepinfra 漏传 baseUrl 的场景）→ UnsupportedError
test('unknown provider without baseUrl throws UnsupportedError', () => {
  const models = createModels();
  assert.throws(() => resolveModel(models, { provider: 'deepinfra', model: 'x' }), UnsupportedError);
});

// keyless：无 envKey 无 apiKey 也能建动态 provider（opencode zen 场景）
test('keyless dynamic provider resolves', () => {
  const models = createModels();
  const r = resolveModel(models, {
    provider: 'opencode', model: 'mimo-v2-pro-free',
    baseUrl: 'https://opencode.net/v1', name: 'MiMo',
    contextWindow: 200000, maxOutput: 8192,
  });
  assert.equal(r.model.provider, 'atbx-opencode');
});

// faux 冒烟：解析出的模型能进 Agent（本测试只验证 model 对象形状可被 getModel 找回）
test('dynamic model registered under its provider id', () => {
  const models = createModels();
  resolveModel(models, {
    provider: 'opencode', model: 'm1', baseUrl: 'https://x.test/v1',
    contextWindow: 1000, maxOutput: 100,
  });
  assert.ok(models.getModel('atbx-opencode', 'm1'));
});
