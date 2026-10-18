import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
async function withFauxServer(t, origins = ['http://localhost:4321'], acpProbe) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const resolve = () => ({ model: faux.getModel(), providerId: faux.provider.id });
  const registry = createRegistry([createPiAdapter({ models, resolve })]);
  // acpProbe 缺省返回 false：测试不该 shell 出去跑 `which`，探活必须确定。
  const srv = await startServer({
    port: 0, allowedOrigins: origins, resolve, models, registry,
    acpProbe: acpProbe ?? (async () => false),
  });
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

// ── 多 agent（ACP）────────────────────────────────────────────────────────────
// ACP 子 agent 逐个出现在 /health，且可被 /sessions 显式选中。
// acpProbe 注入确定性探活：测试不能依赖宿主机是否装了 hermes/codex。

test('health lists each ACP agent with name and availability', async (t) => {
  const { json } = await withFauxServer(t);
  const { status, body } = await json('/health');
  assert.equal(status, 200);
  const ids = body.agents.map((a) => a.id);
  assert.ok(ids.includes('pi'), '既有适配器仍在列表里');
  assert.ok(body.agents.some((a) => a.id === 'acp:hermes' && typeof a.available === 'boolean'));
  assert.ok(body.agents.some((a) => a.id === 'acp:codex' && typeof a.name === 'string'));
  assert.equal(body.agents.filter((a) => a.id.startsWith('acp:')).length, 5, '五个 ACP agent 全部列出');
});

test('sessions can target a specific acp agent', async (t) => {
  const { json } = await withFauxServer(t);
  const r = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux', agent: 'acp:hermes' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.adapter, 'acp');
});

test('acp agent availability reflects the injected probe', async (t) => {
  const { json } = await withFauxServer(t, ['http://localhost:4321'], async (id) => id === 'hermes');
  const { body } = await json('/health');
  assert.equal(body.agents.find((a) => a.id === 'acp:hermes').available, true);
  assert.equal(body.agents.find((a) => a.id === 'acp:codex').available, false);
});

test('explicit agent overrides the data-layer preference order', async (t) => {
  const { json } = await withFauxServer(t);
  const r = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux', agents: ['cc'], agent: 'pi' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.adapter, 'pi', '用户显式选择的 agent 必须赢过偏好序');
});

// 会话级 cwd + toolTier：cwd 必须真实存在（用户在网页粘贴路径，笔误常见 → 400 报错要明确），
// toolTier 未知值安全回落 none（绝不因误传升级权限），缺省 cwd=null。
test('sessions accept and validate cwd + toolTier', async (t) => {
  const { json } = await withFauxServer(t);
  const mk = (body) => json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify(body),
  });
  const ok = await mk({ provider: 'faux', model: 'faux', cwd: '/tmp', toolTier: 'read' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.cwd, '/tmp');
  assert.equal(ok.body.toolTier, 'read');

  const bad = await mk({ provider: 'faux', model: 'faux', cwd: '/no/such/dir-xyz' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid cwd');

  const def = await mk({ provider: 'faux', model: 'faux' });
  assert.equal(def.body.toolTier, 'none');
  assert.equal(def.body.cwd, null);
});

test('pi session with cwd+read tier receives tools via the adapter', async (t) => {
  // 用注入的 registry/pi 适配器捕获 run ctx：断言 server 把 toolTier/cwd 传进 run
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const resolve = () => ({ model: faux.getModel(), providerId: faux.provider.id });
  const captured = [];
  const fakePi = {
    id: 'pi',
    available: async () => true,
    run: async function* (ctx) {
      captured.push(ctx);
      yield { type: 'delta', text: 'ok' };
    },
  };
  const registry = createRegistry([fakePi]);
  const srv = await startServer({
    port: 0, allowedOrigins: ['http://localhost:4321'], resolve, models,
    registry,
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const j = async (path, opts) => {
    const res = await fetch(base + path, opts);
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };

  const create = await j('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux', cwd: '/tmp', toolTier: 'read' }),
  });
  assert.equal(create.status, 200);
  const { sessionId } = create.body;
  const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'hi' }),
  });
  await res.text();
  assert.equal(captured.length, 1, 'adapter.run called once');
  assert.equal(captured[0].toolTier, 'read', 'toolTier threaded');
  assert.equal(captured[0].cwd, '/tmp', 'cwd threaded');
});

test('cc read tier maps to read-only allowedTools', async (t) => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const echoCc = {
    id: 'cc',
    available: async () => true,
    run: async function* (ctx) {
      // 捕获 allowedTools 语义由 cc.mjs 内部处理；这里直接断言 server 传入的 ctx
      yield { type: 'activity', title: `allowedTools=${(ctx.allowedTools ?? []).join(',')}` };
      yield { type: 'delta', text: 'done' };
    },
  };
  const registry = createRegistry([echoCc]);
  const srv = await startServer({ port: 0, allowedOrigins: ['http://localhost:4321'], resolve: () => ({}), models, registry });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const j2 = async (path, opts) => {
    const res = await fetch(base + path, opts);
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  const create = await j2('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'x', model: 'm', agent: 'cc', cwd: '/tmp', toolTier: 'read' }),
  });
  const { sessionId } = create.body;
  const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'hi' }),
  });
  const raw = await res.text();
  assert.match(raw, /allowedTools=Read,Grep,Glob/);
});

// ── /quota/openrouter：用户 key 查自己账号的免费额度 ───────────────────────────
// 网关只做代理：key 在请求体（不进 URL/日志），上游失败只镜像状态码不透传响应体。

test('quota/openrouter proxies the key endpoint without logging the key', async (t) => {
  const calls = [];
  const origFetch = globalThis.fetch;
  // 只拦截发往 openrouter.ai 的上游调用；客户端 → 测试服务器的请求放行给真 fetch，
  // 否则 mock 会短路掉整个往返，路由根本没被执行。
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('openrouter.ai')) return origFetch(url, opts);
    calls.push({ url: String(url), auth: opts?.headers?.authorization });
    return new Response(JSON.stringify({ data: {
      usage: 3, limit: 50, is_free_tier: true, rate_limit: { requests: 20, interval: '10s' },
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { json } = await withFauxServer(t);
    const r = await json('/quota/openrouter', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ apiKey: 'sk-or-test' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.usage, 3);
    assert.equal(r.body.limit, 50);
    assert.equal(r.body.isFreeTier, true);
    assert.deepEqual(r.body.rateLimit, { requests: 20, interval: '10s' });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /openrouter\.ai\/api\/v1\/key/);
    assert.equal(calls[0].auth, 'Bearer sk-or-test', 'key forwarded as Bearer to upstream');
  } finally { globalThis.fetch = origFetch; }
});

test('quota/openrouter without key returns 400', async (t) => {
  const { json } = await withFauxServer(t);
  const r = await json('/quota/openrouter', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 400);
});

test('quota/openrouter mirrors upstream failure status without detail', async (t) => {
  const origFetch = globalThis.fetch;
  // 同上：只拦上游，客户端请求放行（否则 429 假响应直接喂给断言，路由未被覆盖）。
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('openrouter.ai')) return origFetch(url, opts);
    return new Response('{"error":"Rate limit exceeded"}', { status: 429, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { json } = await withFauxServer(t);
    const r = await json('/quota/openrouter', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ apiKey: 'sk-or-test' }),
    });
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'upstream error');
    assert.equal(r.body.detail, undefined, 'upstream body must not leak');
  } finally { globalThis.fetch = origFetch; }
});

test('quota/openrouter returns 502 when upstream is unreachable', async (t) => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('openrouter.ai')) return origFetch(url, opts);
    throw new Error('connect ECONNREFUSED');
  };
  try {
    const { json } = await withFauxServer(t);
    const r = await json('/quota/openrouter', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ apiKey: 'sk-or-test' }),
    });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'upstream unreachable');
  } finally { globalThis.fetch = origFetch; }
});

// ── permission 中枢（Task 9）──────────────────────────────────────────────────
// 适配器 run ctx 新增 requestApproval(action, summary)：网关发 SSE permission_request
// 并挂起，前端在抽屉里点允许/拒绝 → POST /sessions/:id/permission 放行或拒绝；
// 120s（可注入）超时自动拒绝；/abort、断连、会话被逐出时全部按拒绝收敛，不泄漏 promise。

// 权限 stub 适配器：每轮先要一次权限，按答复 yield approved / denied。
// 不用真实适配器——链路只测网关的挂起/应答/超时语义，与 pi/cc 无关。
function permStubAdapter() {
  return {
    id: 'pi',
    available: async () => true,
    run: async function* (ctx) {
      const ok = await ctx.requestApproval('bash', 'run tests');
      yield { type: 'delta', text: ok ? 'approved' : 'denied' };
      yield { type: 'turn_end', stopReason: null };
    },
  };
}

// 与 withFauxServer 同型，但挂 permStub 且可注入审批超时（默认 120s，测试用毫秒级）。
async function withPermServer(t, { approvalTimeoutMs } = {}) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const registry = createRegistry([permStubAdapter()]);
  const srv = await startServer({
    port: 0, allowedOrigins: ['http://localhost:4321'],
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
    models, registry, acpProbe: async () => false,
    ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const json = async (path, opts) => {
    const res = await fetch(base + path, opts);
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  const post = (path, body) => json(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify(body),
  });
  const createSession = async () => {
    const r = await post('/sessions', { provider: 'stub', model: 'stub' });
    assert.equal(r.status, 200);
    return r.body.sessionId;
  };
  // 增量读 SSE：审批测试必须在流中途插入 POST /permission，不能一口气 res.text()
  const openStream = async (sessionId) => {
    const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ text: 'hi' }),
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const next = async () => {
      for (;;) {
        const idx = buf.indexOf('\n\n');
        if (idx !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!block.startsWith('data: ')) continue;
          return JSON.parse(block.slice(6));
        }
        const { done, value } = await reader.read();
        if (done) return null;
        buf += decoder.decode(value, { stream: true });
      }
    };
    return { next };
  };
  return { srv, base, json, post, createSession, openStream };
}

test('permission_request streams to SSE and an allow answer resumes the turn', async (t) => {
  const { srv, createSession, openStream, post } = await withPermServer(t);
  const sessionId = await createSession();
  const { next } = await openStream(sessionId);

  const req = await next();
  assert.equal(req.type, 'permission_request');
  assert.match(req.reqId, /^[0-9a-f-]{36}$/, 'reqId is a uuid');
  assert.equal(req.action, 'bash');
  assert.equal(req.summary, 'run tests');

  // 应答码取 plan 实现草稿的 200 {ok:true}（测试草稿里的 204 二选一，弃用）：
  // 与网关其它 POST 路由一样都回 JSON，前端只看 ok 字段。
  const ans = await post(`/sessions/${sessionId}/permission`, { reqId: req.reqId, decision: 'allow' });
  assert.equal(ans.status, 200);
  assert.deepEqual(ans.body, { ok: true });

  assert.deepEqual(await next(), { type: 'delta', text: 'approved' });
  assert.equal((await next()).type, 'turn_end');
  assert.equal((await next()).type, 'done');
  assert.equal(await next(), null, 'stream closes after done');
  assert.equal(srv.sessions.peek(sessionId).pendingPerms.size, 0, 'pending map drained after answer');
});

test('permission answer with any non-allow decision denies the turn', async (t) => {
  const { createSession, openStream, post } = await withPermServer(t);
  const sessionId = await createSession();
  const { next } = await openStream(sessionId);
  const req = await next();
  assert.equal(req.type, 'permission_request');
  const ans = await post(`/sessions/${sessionId}/permission`, { reqId: req.reqId, decision: 'deny' });
  assert.equal(ans.status, 200);
  assert.deepEqual(await next(), { type: 'delta', text: 'denied' });
  assert.equal((await next()).type, 'turn_end');
  assert.equal((await next()).type, 'done');
});

test('permission answer with unknown reqId or unknown session 404s', async (t) => {
  const { json, createSession, post } = await withPermServer(t);
  const sessionId = await createSession();
  const noReq = await post(`/sessions/${sessionId}/permission`, { reqId: randomUUID(), decision: 'allow' });
  assert.equal(noReq.status, 404);
  assert.equal(noReq.body.error, 'unknown permission request');
  const noSession = await json('/sessions/00000000-0000-4000-8000-000000000000/permission', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ reqId: 'x', decision: 'allow' }),
  });
  assert.equal(noSession.status, 404);
  assert.equal(noSession.body.error, 'unknown session');
});

test('pending permission auto-denies after the injected timeout', async (t) => {
  const { createSession, openStream } = await withPermServer(t, { approvalTimeoutMs: 50 });
  const sessionId = await createSession();
  const { next } = await openStream(sessionId);
  assert.equal((await next()).type, 'permission_request');
  // 不应答：50ms 后网关自动按拒绝收敛，适配器收到 false
  assert.deepEqual(await next(), { type: 'delta', text: 'denied' });
  assert.equal((await next()).type, 'turn_end');
  assert.equal((await next()).type, 'done');
});

test('abort resolves pending permissions as denied and the session stays usable', async (t) => {
  const { srv, json, createSession, openStream, post } = await withPermServer(t);
  const sessionId = await createSession();
  const { next } = await openStream(sessionId);
  assert.equal((await next()).type, 'permission_request');

  const aborted = await json(`/sessions/${sessionId}/abort`, {
    method: 'POST', headers: { Origin: 'http://localhost:4321' },
  });
  assert.equal(aborted.status, 204);
  // 中止必须把挂起的审批 resolve(false)（否则 promise 悬挂泄漏），适配器随即收尾
  assert.deepEqual(await next(), { type: 'delta', text: 'denied' });
  assert.equal((await next()).type, 'turn_end');
  assert.equal((await next()).type, 'done');
  assert.equal(srv.sessions.peek(sessionId).pendingPerms.size, 0, 'pending map cleared on abort');

  // 会话没有卡死在 409：新一轮照常流式、照常审批
  const { next: next2 } = await openStream(sessionId);
  const req2 = await next2();
  assert.equal(req2.type, 'permission_request');
  await post(`/sessions/${sessionId}/permission`, { reqId: req2.reqId, decision: 'allow' });
  assert.deepEqual(await next2(), { type: 'delta', text: 'approved' });
  assert.equal((await next2()).type, 'turn_end');
  assert.equal((await next2()).type, 'done');
});
