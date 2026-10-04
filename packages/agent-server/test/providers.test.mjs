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

// 抽屉的 keyless 行带 envKey 字段（数据里有 OPENCODE_API_KEY）但用户本地没设该 env：
// 内置 opencode provider 硬性要求 env，必须跳过内置分支落到占位 key 动态分支。
// （B1 回归：此前这场景 100% 报 "Provider is not configured"）
test('keyless request with unconfigured envKey skips builtin provider', () => {
  assert.equal(process.env.OPENCODE_API_KEY, undefined, 'precondition: env not set in test runner');
  const models = createModels();
  const r = resolveModel(models, {
    provider: 'opencode', model: 'mimo-v2-pro-free',
    baseUrl: 'https://opencode.ai/zen/v1', envKey: 'OPENCODE_API_KEY',
    name: 'MiMo V2 Pro Free', contextWindow: 200000, maxOutput: 8192,
  });
  assert.equal(r.model.provider, 'atbx-opencode');
});

// env 已设置时仍优先内置目录（鉴权可用，目录 compat 信息更全）
test('builtin provider used when envKey is configured', () => {
  process.env.ATBX_TEST_ENV_KEY = 'test-key-123';
  try {
    const models = createModels();
    const r = resolveModel(models, {
      provider: 'groq', model: 'llama-3.3-70b-versatile', envKey: 'ATBX_TEST_ENV_KEY',
    });
    assert.equal(r.model.provider, 'groq');
  } finally {
    delete process.env.ATBX_TEST_ENV_KEY;
  }
});

// 动态分支 auth 三选一：envKey 有值但 env 未设置 → 占位 key（B1 第二层 gate 回归）。
// 若此处误选 env 鉴权，resolve 返回 undefined → "Provider is not configured"。
test('dynamic branch uses placeholder key when envKey unset', async () => {
  assert.equal(process.env.OPENCODE_API_KEY, undefined, 'precondition: env not set');
  const models = createModels();
  const { model } = resolveModel(models, {
    provider: 'opencode', model: 'wire-k', baseUrl: 'https://x.test/v1',
    envKey: 'OPENCODE_API_KEY', name: 'Wire', contextWindow: 1000, maxOutput: 100,
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'wire-k',
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }) + '\n\n' +
    'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'wire-k',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const s = models.streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] });
    let sawText = false; let err = null;
    for await (const ev of s) {
      if (ev.type === 'text_delta') sawText = true;
      if (ev.type === 'error') err = ev.error?.errorMessage;
    }
    assert.equal(err, null, `stream error: ${err}`);
    assert.ok(sawText, 'keyless envKey path reaches the wire');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// 动态分支：显式 apiKey 覆盖一切（BYOK 直接用它，不碰 env）
test('dynamic branch prefers explicit apiKey over envKey', async () => {
  process.env.ATBX_TEST_ENV_KEY2 = 'env-key';
  try {
    const models = createModels();
    const { model } = resolveModel(models, {
      provider: 'zai', model: 'wire-byok', baseUrl: 'https://x.test/v1',
      envKey: 'ATBX_TEST_ENV_KEY2', apiKey: 'byok-key',
      name: 'Wire', contextWindow: 1000, maxOutput: 100,
    });
    let authHeader = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_url, opts) => {
      // pi-ai 传 Headers 实例，需用 get() 读取
      const h = opts?.headers;
      authHeader = typeof h?.get === 'function' ? h.get('authorization') : (h?.authorization ?? h?.Authorization ?? null);
      return new Response(
        'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'wire-byok',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }) + '\n\n' +
        'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'wire-byok',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const s = models.streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] });
      for await (const ev of s) { if (ev.type === 'error') throw new Error(ev.error?.errorMessage); if (ev.type === 'text_delta') break; }
    } finally {
      globalThis.fetch = origFetch;
    }
    assert.equal(authHeader, 'Bearer byok-key');
  } finally {
    delete process.env.ATBX_TEST_ENV_KEY2;
  }
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
