import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { createRegistry } from '../src/adapters/registry.mjs';
import { createPiAdapter } from '../src/adapters/pi.mjs';

// /health 的 grantedDirs 来自网关配置文件。重定向到临时路径，断言才不依赖开发者本机
// 是否已 grant 过目录；DEFAULT_CONFIG_PATH 在 config.mjs 被 import 时求值，因此
// server.mjs（→ config.mjs）必须动态 import，让这次重定向先生效。
process.env.ATBX_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), 'atbx-srv-cfg-')), 'config.json');
const { startServer } = await import('../src/server.mjs');

// 每个测试起独立 server + faux provider。
// 显式注入 registry（只含承接 faux 的 pi 适配器）：默认 registry 里的 cc 适配器会探活
// 真实的 claude 二进制，测试要的是确定性的 faux 路由，不能依赖宿主机是否装了 claude。
async function withFauxServer(t, origins = ['http://localhost:4321']) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const resolve = () => ({ model: faux.getModel(), providerId: faux.provider.id });
  const registry = createRegistry([createPiAdapter({ models, resolve })]);
  const srv = await startServer({ port: 0, allowedOrigins: origins, resolve, models, registry });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const json = async (path, opts) => {
    const res = await fetch(base + path, opts);
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  return { srv, base, json, faux, models };
}

test('health returns ok + version', async (t) => {
  const { json } = await withFauxServer(t);
  const { status, body } = await json('/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
});

test('CORS: allowed origin passes, unknown origin blocked', async (t) => {
  const { json } = await withFauxServer(t, ['https://dengzhh.github.io']);
  const good = await json('/health', { headers: { Origin: 'https://dengzhh.github.io' } });
  assert.equal(good.status, 200);
  const bad = await json('/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.status, 403);
});

test('preflight includes PNA header', async (t) => {
  const { base } = await withFauxServer(t);
  const res = await fetch(base + '/sessions', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:4321',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Private-Network': 'true',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
});

test('session + message round-trip streams SSE', async (t) => {
  const { json, base, faux } = await withFauxServer(t);
  faux.setResponses([fauxAssistantMessage([fauxText('Hello from faux!')])]);
  const create = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux' }),
  });
  assert.equal(create.status, 200);
  const { sessionId } = create.body;

  const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const raw = await res.text();
  const events = raw.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
  const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.equal(deltas, 'Hello from faux!');
  assert.ok(events.some((e) => e.type === 'turn_end'));
  assert.equal(events.at(-1).type, 'done');
});

test('unknown session 404, malformed JSON 400', async (t) => {
  const { json } = await withFauxServer(t);
  assert.equal((await json('/sessions/nope/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'x' }),
  })).status, 404);
  assert.equal((await json('/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: '{oops',
  })).status, 400);
});

// provider 失败编码为 turn_end{stopReason:'error'} + errorMessage → 必须转发 error 帧，
// 否则错 key 的用户只看到空白回复（agent.prompt 不 reject）
test('provider error surfaces as SSE error frame', async (t) => {
  const { json, base, faux } = await withFauxServer(t);
  // faux 队列耗尽 → stream 报错
  const create = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux' }),
  });
  const { sessionId } = create.body;
  const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'hi' }),
  });
  const events = (await res.text()).split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
  assert.ok(events.some((e) => e.type === 'error'), 'error frame present');
  assert.equal(events.at(-1).type, 'done');
  void faux;
});

// body 校验失败必须释放 streaming 占位，否则会话卡死在 409
test('failed body validation releases the streaming slot', async (t) => {
  const { json, base } = await withFauxServer(t);
  const create = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux' }),
  });
  const { sessionId } = create.body;
  assert.equal((await json(`/sessions/${sessionId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: '   ' }),
  })).status, 400);
  // 占位已释放：合法请求应正常进入 SSE 而非 409
  faux_set: {
    const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ text: 'hi' }),
    });
    assert.equal(res.status, 200);
    await res.text();
  }
});

// /health 新增 agents 字段：注册表逐适配器探活
test('health reports adapters and granted dirs', async (t) => {
  const { json } = await withFauxServer(t);
  const { status, body } = await json('/health');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.agents), 'agents array present');
  assert.ok(body.agents.some((a) => a.id === 'pi' && a.available === true), 'pi available');
  assert.deepEqual(body.grantedDirs, []);
});

// /sessions 新增 adapter 字段：告诉前端这一会话由谁承接（pick 是异步探活）
test('session response reports the adapter that will serve it', async (t) => {
  const { json } = await withFauxServer(t);
  const create = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux' }),
  });
  assert.equal(create.status, 200);
  assert.equal(create.body.adapter, 'pi');
});

// 多轮上下文回归：前端每轮只发 `{ text }`，历史只能由服务端持有——pi 适配器按
// sessionId 跨轮缓存同一个 Agent。若改回「每轮新建 Agent」，第 2 轮发给模型的输入
// 会退化成 system + 本轮 user（实测过：4 条 → 2 条），此断言即红。
// 普通往返测试抓不到：SSE 契约不变，回复依旧正确，只是模型忘了前文。
test('multi-turn: the second turn carries the earlier transcript', async (t) => {
  const { json, base, faux } = await withFauxServer(t);
  const seen = [];
  // faux 的 response 可以是函数：拿到本轮的 context（即真正发给模型的消息）
  const capture = (reply) => (ctx) => {
    seen.push(ctx.messages);
    return fauxAssistantMessage([fauxText(reply)]);
  };
  faux.setResponses([capture('reply one'), capture('reply two')]);

  const create = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux' }),
  });
  const { sessionId } = create.body;
  for (const text of ['first question', 'second question']) {
    const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ text }),
    });
    assert.equal(res.status, 200);
    await res.text();
  }

  assert.equal(seen.length, 2, 'model called once per turn');
  const second = JSON.stringify(seen[1]);
  assert.ok(second.includes('first question'), 'turn 2 carries the first user turn');
  assert.ok(second.includes('reply one'), 'turn 2 carries the first assistant turn');
  assert.deepEqual(
    seen[1].filter((m) => m.role !== 'system').map((m) => m.role),
    ['user', 'assistant', 'user'],
    'transcript accumulates in order',
  );
});
