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

// 缺 provider/model → UnsupportedError（而非 TypeError → 500）
test('missing provider or model throws UnsupportedError', () => {
  const models = createModels();
  assert.throws(() => resolveModel(models, { baseUrl: 'https://x.test/v1' }), UnsupportedError);
  assert.throws(() => resolveModel(models, { provider: 'zai' }), UnsupportedError);
});

// keyless 动态 provider 的流式冒烟：占位 key 让请求真正发出（stub fetch），
// 防止 auth resolve 返回空导致 openai-completions 在本地抛 "No API key"
test('keyless dynamic provider reaches the wire with placeholder key', async () => {
  const models = createModels();
  resolveModel(models, {
    provider: 'opencode', model: 'wire-m', baseUrl: 'https://x.test/v1',
    name: 'Wire', contextWindow: 1000, maxOutput: 100,
  });
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(url);
    // pi-ai 适配器按 OpenAI 流式协议解析：返回 text/event-stream 的分块响应
    const sseBody =
      'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'wire-m',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }) + '\n\n' +
      'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'wire-m',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n';
    return new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  t_refetch: try {
    const stream = models.streamSimple(models.getModel('atbx-opencode', 'wire-m'), {
      messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
    });
    let sawText = false; let sawError = null;
    for await (const ev of stream) {
      if (ev.type === 'text_delta') sawText = true;
      if (ev.type === 'error') sawError = ev.error?.message ?? 'error';
    }
    assert.equal(calls.length, 1, 'exactly one HTTP request');
    assert.ok(sawText, 'stream produced text');
    assert.equal(sawError, null);
    break t_refetch;
  } finally {
    globalThis.fetch = origFetch;
  }
});
