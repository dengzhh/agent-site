import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { createRegistry } from '../src/adapters/registry.mjs';
import { createPiAdapter } from '../src/adapters/pi.mjs';
import { TranscriptStore } from '../src/transcripts.mjs';
import { createCcAdapter } from '../src/adapters/cc.mjs';

const freshDir = () => mkdtempSync(join(tmpdir(), 'atbx-srv-'));
// 测试用的临时 transcript store，随测试结束回收。所有 startServer 调用都必须
// 注入一份：落回 startServer 自建的默认 store 就是在开发者真实会话目录上建目录。
const mkStore = (t) => {
  const dir = freshDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new TranscriptStore({ dir });
};


// /health 的 grantedDirs 来自网关配置文件。重定向到临时路径，断言才不依赖开发者本机
// 是否已 grant 过目录；DEFAULT_CONFIG_PATH 在 config.mjs 被 import 时求值，因此
// server.mjs（→ config.mjs）必须动态 import，让这次重定向先生效。
process.env.ATBX_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), 'atbx-srv-cfg-')), 'config.json');
const { startServer } = await import('../src/server.mjs');
// 同一个 config 模块实例：列表里的 piSessionDir 必须与这里读到的完全一致
const { piSessionDir } = await import('../src/config.mjs');

// 每个测试起独立 server + faux provider。
// 显式注入 registry（只含承接 faux 的 pi 适配器）：默认 registry 里的 cc 适配器会探活
// 真实的 claude 二进制，测试要的是确定性的 faux 路由，不能依赖宿主机是否装了 claude。
async function withFauxServer(t, origins = ['http://localhost:4321'], acpProbe, transcripts) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const resolve = () => ({ model: faux.getModel(), providerId: faux.provider.id });
  // ⚠️ store 必须同时进适配器：这里注入的 registry 会顶掉 startServer 里的
  // 默认 registry，而 adapter.restore() 是适配器上的方法 —— 它内部
  // loadPersistedMessages 在 transcripts 为空时直接返回 null。
  const registry = createRegistry([createPiAdapter({ models, resolve, transcripts: transcripts ?? null })]);
  // acpProbe 缺省返回 false：测试不该 shell 出去跑 `which`，探活必须确定。
  const srv = await startServer({
    port: 0, allowedOrigins: origins, resolve, models, registry,
    acpProbe: acpProbe ?? (async () => false),
    // 始终注入 store：没给就开一个临时目录的。不能让它落回 startServer 的默认
    // store——那是开发者真实的会话目录，测试不该在那里建目录、更不该碰它。
    transcripts: transcripts ?? mkStore(t),
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

// 自建 store（没注入 transcripts）时目录必须经 sessionStoreDir()：CLI 与网关看
// 同一处历史，靠的就是这一个来源。不做这个断言的话，一处改路径另一处没改，
// 两个功能各自「全绿」——网页写的会话 CLI 永远列不出来。用真的一轮写入钉
// （无 store 的 server 落到开发者真实会话目录的风险由上面的静态守卫挡）。
test('a store-less server persists into ATBX_SESSION_DIR (same dir the CLI lists)', async (t) => {
  const dir = freshDir();
  const saved = process.env.ATBX_SESSION_DIR;
  process.env.ATBX_SESSION_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.ATBX_SESSION_DIR; else process.env.ATBX_SESSION_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const resolve = () => ({ model: faux.getModel(), providerId: faux.provider.id });
  // 刻意不传 transcripts：测的就是 startServer 自建 store 的那条分支。
  const srv = await startServer({
    port: 0, allowedOrigins: ['http://localhost:4321'], resolve, models,
    registry: createRegistry([createPiAdapter({ models, resolve, transcripts: null })]),
    acpProbe: async () => false,
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const created = await (await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux' }),
  })).json();
  const res = await fetch(`${base}/sessions/${created.sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'hi' }),
  });
  await res.text();
  assert.ok(readdirSync(dir).includes(`${created.sessionId}.json`), `turn was not persisted into ATBX_SESSION_DIR (saw: ${readdirSync(dir).join(', ')})`);
  // 同一目录能被 CLI 用的 store 读出——这是「终端 list 看得到网页的会话」的最小证明
  assert.equal(new TranscriptStore({ dir }).get(created.sessionId)?.id, created.sessionId);
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
    transcripts: mkStore(t),
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
  const srv = await startServer({ port: 0, allowedOrigins: ['http://localhost:4321'], resolve: () => ({}), models, registry, transcripts: mkStore(t) });
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
      usage: 25.5, limit: 100, limit_remaining: 74.5, is_free_tier: false,
      free_model_daily_requests: { limit: 1000, used: 12, remaining: 988 },
      rate_limit: { requests: 20, interval: '10s', note: 'deprecated' },
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
    // 语义断言：credits 与免费模型请求数是两组不同的量，不能被混成一个字段
    assert.equal(r.body.creditsUsed, 25.5);
    assert.equal(r.body.creditLimit, 100);
    assert.equal(r.body.creditRemaining, 74.5);
    assert.equal(r.body.freeRequests, 1000, 'daily free-model request ceiling, NOT credits');
    assert.equal(r.body.freeUsed, 12);
    assert.equal(r.body.freeRemaining, 988);
    assert.equal(r.body.isFreeTier, false);
    // is_free_tier=false 却配 1000/天：证明限额不由 isFreeTier 决定（官方口径）
    assert.equal(r.body.rateLimit, undefined, 'deprecated field is not forwarded');
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

// 核心不变量：拿不到就必须是 null。UI 靠 null 显示"未知"；若这里回 0，
// 用户会看到一个凭空捏造的余额／限额（本站此前正是这么错的）。
test('quota/openrouter reports null (never 0/NaN) for absent or non-numeric fields', async (t) => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('openrouter.ai')) return origFetch(url, opts);
    return new Response(JSON.stringify({ data: {
      is_free_tier: true,
      free_model_daily_requests: { limit: '50', used: NaN, remaining: null },
      limit: undefined, usage: 'oops',
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
    for (const k of ['creditsUsed', 'creditLimit', 'creditRemaining', 'freeRequests', 'freeUsed', 'freeRemaining']) {
      assert.equal(r.body[k], null, `${k} must be null when upstream has no usable number`);
    }
    assert.equal(r.body.isFreeTier, true, 'boolean survives; non-numbers do not');
  } finally { globalThis.fetch = origFetch; }
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
    models, registry, acpProbe: async () => false, transcripts: mkStore(t),
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

test('sessions accept toolTier full (write/execute tier)', async (t) => {
  const { json } = await withFauxServer(t);
  const mk = (toolTier) => json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux', cwd: '/tmp', toolTier }),
  });
  const full = await mk('full');
  assert.equal(full.status, 200);
  assert.equal(full.body.toolTier, 'full');
  const unknown = await mk('sudo');   // 未知值仍安全回落 none，绝不因误传升级权限
  assert.equal(unknown.body.toolTier, 'none');
});

test('full-tier session threads requestApproval through the run ctx', async (t) => {
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
    port: 0, allowedOrigins: ['http://localhost:4321'], resolve, models, registry,
    acpProbe: async () => false, transcripts: mkStore(t),
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const create = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux', cwd: '/tmp', toolTier: 'full' }),
  });
  const { sessionId } = await create.json();
  const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'hi' }),
  });
  await res.text();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].toolTier, 'full', 'full tier threaded');
  assert.equal(typeof captured[0].requestApproval, 'function', 'approval gate injected for full tier');
});

// ── 权限中枢复审补充：并发审批 / 逐出收敛 / abort 信号即时收敛 ──────────────────

// 并发审批 stub：一轮里同时挂起两个审批（bash + write），按各自应答拼 delta。
// 验证两张权限卡相互独立：不同 reqId、应答互不串扰。
function dualPermStubAdapter() {
  return {
    id: 'pi',
    available: async () => true,
    run: async function* (ctx) {
      const [a, b] = await Promise.all([
        ctx.requestApproval('bash', 'first command'),
        ctx.requestApproval('write', 'second file'),
      ]);
      yield { type: 'delta', text: `first=${a ? 'allow' : 'deny'} second=${b ? 'allow' : 'deny'}` };
      yield { type: 'turn_end', stopReason: null };
    },
  };
}

async function withStubServer(t, stub, opts = {}) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const registry = createRegistry([stub]);
  const srv = await startServer({
    port: 0, allowedOrigins: ['http://localhost:4321'],
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
    models, registry, acpProbe: async () => false, transcripts: mkStore(t),
    ...(opts.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: opts.approvalTimeoutMs }),
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const post = async (path, body, headers = { 'content-type': 'application/json', Origin: 'http://localhost:4321' }) => {
    const res = await fetch(base + path, { method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  const createSession = async () => {
    const r = await post('/sessions', { provider: 'stub', model: 'stub' });
    assert.equal(r.status, 200);
    return r.body.sessionId;
  };
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
  return { srv, base, post, createSession, openStream };
}

test('concurrent approvals: two independent reqIds, answers route independently', async (t) => {
  const { srv, post, createSession, openStream } = await withStubServer(t, dualPermStubAdapter());
  const sessionId = await createSession();
  const { next } = await openStream(sessionId);

  const first = await next();
  const second = await next();
  assert.equal(first.type, 'permission_request');
  assert.equal(second.type, 'permission_request');
  assert.notEqual(first.reqId, second.reqId, 'two cards, two reqIds');
  assert.equal(first.action, 'bash');
  assert.equal(second.action, 'write');

  // 只答第一张：第二张必须仍挂起（答 A 不 resolve B）
  const denyFirst = await post(`/sessions/${sessionId}/permission`, { reqId: first.reqId, decision: 'deny' });
  assert.equal(denyFirst.status, 200);
  assert.equal(srv.sessions.peek(sessionId).pendingPerms.size, 1, 'second approval still pending');

  // 再答第二张：两个答案各自路由到对应的 promise
  const allowSecond = await post(`/sessions/${sessionId}/permission`, { reqId: second.reqId, decision: 'allow' });
  assert.equal(allowSecond.status, 200);
  assert.deepEqual(await next(), { type: 'delta', text: 'first=deny second=allow' });
  assert.equal((await next()).type, 'turn_end');
  assert.equal((await next()).type, 'done');
  assert.equal(srv.sessions.peek(sessionId).pendingPerms.size, 0, 'both cards drained');

  // 已收敛的 reqId 重放按 404（幂等）
  const replay = await post(`/sessions/${sessionId}/permission`, { reqId: first.reqId, decision: 'allow' });
  assert.equal(replay.status, 404);
});

test('session eviction mid-approval denies the pending approval', async (t) => {
  const { srv, post, createSession, openStream } = await withStubServer(t, permStubAdapter());
  const sessionId = await createSession();
  const { next } = await openStream(sessionId);
  assert.equal((await next()).type, 'permission_request');

  // 灌满会话存储（容量 16）：被审批挂起的会话成了 LRU 最老项，被逐出。
  // dispose → 挂起审批按拒绝收敛 → stub 收到 false 正常收尾，无悬挂/未处理 rejection。
  for (let i = 0; i < 16; i++) {
    const r = await post('/sessions', { provider: 'stub', model: 'stub' });
    assert.equal(r.status, 200);
  }
  assert.equal(srv.sessions.peek(sessionId), undefined, 'session evicted');

  assert.deepEqual(await next(), { type: 'delta', text: 'denied' }, 'pending approval resolved false');
  assert.equal((await next()).type, 'turn_end');
  assert.equal((await next()).type, 'done', 'turn finishes sanely after eviction');
});

test('aborting the turn signal resolves a pending approval immediately', async (t) => {
  const { srv, post, createSession, openStream } = await withStubServer(t, permStubAdapter());
  const sessionId = await createSession();
  const { next } = await openStream(sessionId);
  assert.equal((await next()).type, 'permission_request');

  try {
    // 直接触发回合的 AbortController（session.cancel 即 /abort 挂的钩子）：
    // 收敛只能来自挂在 ac.signal 上的监听——解析要即时，且挂起表要清空。
    srv.sessions.peek(sessionId).cancel();
    const ev = await Promise.race([
      next(),
      new Promise((r) => setTimeout(() => r({ type: 'still-pending' }), 2000)),
    ]);
    assert.deepEqual(ev, { type: 'delta', text: 'denied' }, 'abort resolves the approval right away');
    assert.equal((await next()).type, 'turn_end');
    assert.equal((await next()).type, 'done');
    assert.equal(srv.sessions.peek(sessionId).pendingPerms.size, 0, 'pending map cleared on signal abort');
  } finally {
    // 失败路径兜底：收敛可能仍挂起的审批并结束流，服务器才能关闭（不让测试拖到 120s 超时）
    await post(`/sessions/${sessionId}/abort`).catch(() => {});
  }
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

// ── Task 6：历史路由 + persistId 恢复 ─────────────────────────────────────────

test('GET /sessions lists history for the given config, newest first', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    // 带 messages：hideEmpty 之下仍算历史（见下一条「空会话不进列表」）
    const msg = [{ role: 'user', content: 'hi', timestamp: 1 }];
    store.save({ id: 'old', agent: 'pi', cwd: '/tmp/x', provider: 'faux', model: 'faux', lastUsed: 1, title: '旧', messages: msg });
    store.save({ id: 'new', agent: 'pi', cwd: '/tmp/x', provider: 'faux', model: 'faux', lastUsed: 2, title: '新', messages: msg });
    const { status, body } = await json('/sessions?agent=pi&cwd=%2Ftmp%2Fx');
    assert.equal(status, 200);
    assert.deepEqual(body.sessions.map((s) => s.id), ['new', 'old']);
    assert.equal(body.sessions[0].messages, undefined, 'list payload stays metadata-only');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 用户看到的「(无标题) · 刚刚 + 删除图标」就是这些空壳：网关建会话时即落盘，
// 没发过消息所以既无 title 也无 messages。落盘时机不能改（筛选键要立即可查），
// 故 GET /sessions 用 hideEmpty 把它们挡在外面。
test('GET /sessions hides sessions that never sent a message', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    store.save({
      id: 'real', agent: 'pi', cwd: '/tmp/x', provider: 'faux', model: 'faux',
      title: '真对话', messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
    });
    // 空壳：与 server.mjs 建会话时写的那次完全一致（只有配置字段，没有 messages）
    store.save({ id: 'shell', agent: 'pi', cwd: '/tmp/x', provider: 'faux', model: 'faux' });
    // cc 的桩记录：configDir 已建、ccSessionId 显式 null
    store.save({ id: 'stub', adapter: 'cc', agent: 'cc', cwd: '/tmp/x', provider: 'faux', model: 'faux', ccSessionId: null });
    const { body } = await json('/sessions?agent=pi&cwd=%2Ftmp%2Fx');
    assert.deepEqual(body.sessions.map((s) => s.id), ['real'], 'empty shell must not show up');
    // cc 桩记录也别出现（不同 agent，这条只证明它在 cc 维度下同样被挡）
    const cc = await json('/sessions?agent=cc&cwd=%2Ftmp%2Fx');
    assert.deepEqual(cc.body.sessions.map((s) => s.id), [], 'cc stub record must not show up');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 过滤只是读取侧：空壳仍可被单条删除（否则用户在别处建的空壳永远删不掉）。
test('a hidden empty session is still deletable by id', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    store.save({ id: 'shell', agent: 'pi', cwd: '/tmp/x', provider: 'faux', model: 'faux' });
    const { body } = await json('/sessions?agent=pi&cwd=%2Ftmp%2Fx');
    assert.deepEqual(body.sessions.map((s) => s.id), [], 'hidden from the list');
    const del = await json(`/sessions/${'shell'}`, { method: 'DELETE', headers: { Origin: 'http://localhost:4321' } });
    assert.equal(del.status, 204, 'DELETE must not go through the filtered list');
    assert.equal(store.get('shell'), null, 'record is actually gone');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 9e35bb7 的回归：cc 跑完一轮后记录里没有 messages，别把它筛掉 ──────────────
//
// cc 的历史在 CLI 自己的 projects/<slug>/<id>.jsonl 里，靠 --resume 续；我们的
// 记录只留 configDir/ccSessionId 两个指针（见 cc.mjs 的 turn_end 写入），
// **永远**没有 messages。hideEmpty 曾按「有没有 messages」判，于是 cc/acp 的
// 真会话全部从列表消失，只剩 pi 的空壳——用户看到「换模型进 chat，历史全没了」。
// 这条测试走真实路径（真 server + 真 cc 适配器 + 假 CC 夹具）端到端钉住它：
// 层间 mock 全换成手写 store.save() 的话，这个回归照样能溜过去——上一批测试
// 正是这么漏的（8 条 hideEmpty 测试全是 pi 形状，没有一条覆盖 cc）。
test('a cc session that ran a turn stays in the history list', async (t) => {
  process.env.ATBX_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), 'atbx-cc-list-cfg-')), 'config.json');
  const { startServer } = await import('../src/server.mjs');
  const { createRegistry } = await import('../src/adapters/registry.mjs');
  const { createCcAdapter } = await import('../src/adapters/cc.mjs');
  const dir = freshDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new TranscriptStore({ dir });
  // 假 CC 夹具：回放一轮完整对话（init → delta → result）。
  // cliPath 指到 fake-claude.sh，cc 适配器的 available() 只查文件可执行。
  // ⚠️ transcripts 必须同时进适配器：registry 会顶掉 startServer 自建的默认
  // registry，不传的话适配器退回内存 Map，turn_end 写得进内存、落不了盘——
  // 这条测试要的正是「落盘后的记录长什么样」。
  const registry = createRegistry([createCcAdapter({
    cliPath: join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude.sh'),
    transcripts: store,
  })]);
  const srv = await startServer({
    port: 0, allowedOrigins: ['http://localhost:4321'], registry,
    acpProbe: async () => false, transcripts: store,
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const json = async (path, opts = {}) => {
    const res = await fetch(base + path, { ...opts, headers: { Origin: 'http://localhost:4321', ...(opts.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const created = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'openrouter', model: 'm:free', agent: 'cc', cwd: '/tmp', toolTier: 'read' }),
  });
  assert.equal(created.status, 200);
  const sessionId = created.body.sessionId;

  // 真发一轮：走 /messages（SSE），让 cc 适配器在 turn_end 时写下它的字段
  const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'hi' }),
  });
  await res.text();

  const rec = store.get(sessionId);
  assert.equal(rec.ccSessionId, 'fake-sess-1', 'the turn really completed');
  assert.equal(rec.messages, undefined,
    'precondition: a cc record carries no messages — history lives in the CLI jsonl');

  const listed = await json('/sessions?agent=cc&cwd=%2Ftmp&provider=openrouter&model=m%3Afree');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.sessions.map((s) => s.id), [sessionId],
    'a finished cc turn is history even though our record has no messages');
  // 标题也由网关派生（cc 的记录里没有 messages，只有看得见 body.text 的这一层
  // 能派）。否则这一行显示成「(无标题)」——用户最初抱怨的那一排。
  assert.equal(store.get(sessionId).title, 'hi', 'cc records get a title from the first user text');
  assert.equal(listed.body.sessions[0].title, 'hi', 'the title reaches the list payload');
});

// 标题只在**首轮**写：后续轮次不能把它冲掉（列表第一行永远是第一条问句）。
// 这条同时钉住「用户手动改过的标题不被覆盖」——pi 那条路径同源。
test('a later turn does not overwrite the session title', async (t) => {
  process.env.ATBX_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), 'atbx-cc-title-cfg-')), 'config.json');
  const { startServer } = await import('../src/server.mjs');
  const { createRegistry } = await import('../src/adapters/registry.mjs');
  const { createCcAdapter } = await import('../src/adapters/cc.mjs');
  const dir = freshDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new TranscriptStore({ dir });
  const registry = createRegistry([createCcAdapter({
    cliPath: join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude.sh'),
    transcripts: store,
  })]);
  const srv = await startServer({
    port: 0, allowedOrigins: ['http://localhost:4321'], registry,
    acpProbe: async () => false, transcripts: store,
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const json = async (path, opts = {}) => {
    const res = await fetch(base + path, { ...opts, headers: { Origin: 'http://localhost:4321', 'content-type': 'application/json' } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const created = await json('/sessions', {
    method: 'POST',
    body: JSON.stringify({ provider: 'openrouter', model: 'm:free', agent: 'cc', cwd: '/tmp', toolTier: 'read' }),
  });
  const id = created.body.sessionId;
  const turn = async (text) => {
    const res = await fetch(`${base}/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ text }),
    });
    await res.text();
  };
  await turn('第一条问句');
  assert.equal(store.get(id).title, '第一条问句', 'title comes from the first turn');
  await turn('第二条问句');
  assert.equal(store.get(id).title, '第一条问句', 'a later turn must not rename the session');
});

// 失败轮不写标题：这一轮什么都没留下（ccSessionId 也不会写，记录仍会被
// hideEmpty 挡在列表外），拿它的 text 当会话名等于给一个不存在的对话命名。
// 真正的标题由**首个成功的回合**派生。
test('a failed turn leaves the session untitled', async (t) => {
  process.env.ATBX_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), 'atbx-cc-fail-cfg-')), 'config.json');
  const { startServer } = await import('../src/server.mjs');
  const { createRegistry } = await import('../src/adapters/registry.mjs');
  const { createCcAdapter } = await import('../src/adapters/cc.mjs');
  const dir = freshDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new TranscriptStore({ dir });
  const registry = createRegistry([createCcAdapter({
    cliPath: join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude.sh'),
    // FAKE_CC_MODE=error：CLI 回一条 is_error 的 result（真实 500 的样子）
    env: { FAKE_CC_MODE: 'error' },
    transcripts: store,
  })]);
  const srv = await startServer({
    port: 0, allowedOrigins: ['http://localhost:4321'], registry,
    acpProbe: async () => false, transcripts: store,
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const created = await (await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'openrouter', model: 'm:free', agent: 'cc', cwd: '/tmp', toolTier: 'read' }),
  })).json();
  const id = created.sessionId;
  const res = await fetch(`${base}/sessions/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: '这一轮会失败' }),
  });
  await res.text();
  const rec = store.get(id);
  assert.equal(rec.title, undefined, 'a failed turn must not name the session');
  // ccSessionId 是 null（建目录时写的桩），不是 undefined：这一轮失败，
  // 适配器不写 id，只留下一个空目录。下一轮跑成功才会有真 id。
  assert.equal(rec.ccSessionId, null, 'and it left only the stub record');
});

test('POST /sessions with a persistId resumes instead of creating', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    store.save({
      id: 'resume-me', adapter: 'pi', agent: 'pi', provider: 'faux', model: 'faux',
      cwd: '/tmp', toolTier: 'none', messages: [{ role: 'user', content: 'earlier', timestamp: 1 }],
    });
    const r = await json('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ provider: 'faux', model: 'faux', persistId: 'resume-me' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.sessionId, 'resume-me', 'memory session id == persistId when resuming');
    assert.equal(r.body.resumed, true, 'tells the client this is a resume, not a fresh chat');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resuming a persistId that is already live is refused with 409', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    store.save({ id: 'dup', adapter: 'pi', agent: 'pi', provider: 'faux', model: 'faux', cwd: '/tmp', messages: [{ role: 'user', content: 'x', timestamp: 1 }] });
    const first = await json('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ provider: 'faux', model: 'faux', persistId: 'dup' }),
    });
    assert.equal(first.status, 200);
    const second = await json('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ provider: 'faux', model: 'faux', persistId: 'dup' }),
    });
    assert.equal(second.status, 409, 'two tabs must not share one transcript');
    assert.match(second.body.error, /already active/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DELETE /sessions/:id removes the history', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    store.save({ id: 'bye', agent: 'pi', cwd: '/tmp', provider: 'faux', model: 'faux' });
    const r = await json('/sessions/bye', { method: 'DELETE', headers: { Origin: 'http://localhost:4321' } });
    assert.equal(r.status, 204);
    assert.equal(store.get('bye'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('POST /sessions/clear clears only the given filter scope', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    store.save({ id: 'a', agent: 'pi', cwd: '/tmp/x', provider: 'faux', model: 'faux' });
    store.save({ id: 'b', agent: 'pi', cwd: '/tmp/y', provider: 'faux', model: 'faux' });
    const r = await json('/sessions/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ cwd: '/tmp/x' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.cleared, 1, 'only the matching scope');
    assert.equal(store.get('b')?.id, 'b', 'other cwd untouched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 活跃会话（内存里还在跑）的记录不删——下一轮会把整份历史重新写回去，
// 删了等于没删。clear 跳过它们，cleared 只数真删的（同 DELETE 的 409 原则）。
test('POST /sessions/clear keeps the active session\'s record', async (t) => {
  const store = mkStore(t);
  const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
  // 注册一个内存里的活跃会话（faux 适配器），再补上它的盘上记录
  const created = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ adapter: 'pi', provider: 'faux', model: 'faux' }),
  });
  assert.equal(created.status, 200);
  const liveId = created.body.sessionId;
  store.save({ id: liveId, agent: 'pi', cwd: '/tmp/x', provider: 'faux', model: 'faux' });
  store.save({ id: 'gone', agent: 'pi', cwd: '/tmp/x', provider: 'faux', model: 'faux' });
  const r = await json('/sessions/clear', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ cwd: '/tmp/x' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.cleared, 1, 'only the inactive record counts');
  assert.equal(store.get('gone'), null, 'inactive record is gone');
  assert.equal(store.get(liveId)?.id, liveId, 'active session\'s record survives');
});

test('clear with no usable filter is a 400, not a crash or a wipe-everything', async (t) => {
  const store = mkStore(t);
  const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
  store.save({ id: 'keep', agent: 'pi', cwd: '/tmp/x' });
  for (const body of [{}, { agent: 42 }, { cwd: '' }, { agnet: 'pi' }]) {
    const r = await json('/sessions/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.equal(store.get('keep')?.id, 'keep', 'nothing was cleared');
});

test('POST /sessions rejects a persistId that is not a safe id', async (t) => {
  const store = mkStore(t);
  const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
  for (const persistId of ['../../etc/passwd', 'a/b', '.hidden', 'x'.repeat(129)]) {
    const r = await json('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ adapter: 'pi', persistId }),
    });
    assert.equal(r.status, 400, `expected 400 for ${persistId}`);
  }
});

test('DELETE /sessions/:id refuses an active session', async (t) => {
  const store = mkStore(t);
  const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
  const created = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ adapter: 'pi', provider: 'faux', model: 'faux' }),
  });
  const id = created.body.sessionId;
  const r = await json(`/sessions/${id}`, { method: 'DELETE', headers: { Origin: 'http://localhost:4321' } });
  assert.equal(r.status, 409, 'deleting a live session would just come back on the next turn');
  assert.equal(store.get(id)?.id, id, 'history is still there');
});

// 恢复时不带 agent（前端按 id 恢复不一定会带）：盘上记的是 cc，就不能被
// 一次 pi 的恢复改写成 pi，否则按 agent 筛的列表会把它归错类。
test('resuming a record does not rewrite its adapter/agent', async (t) => {
  const store = mkStore(t);
  const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
  store.save({ id: 'been-here', adapter: 'cc', agent: 'cc', cwd: '/tmp/x' });
  const r = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ adapter: 'pi', persistId: 'been-here' }),
  });
  assert.equal(r.status, 200);
  const rec = store.get('been-here');
  assert.equal(rec.adapter, 'cc', 'ownership comes from disk');
  assert.equal(rec.agent, 'cc');
  // 对照：新建的会话照常写上归属
  const fresh = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ adapter: 'pi', provider: 'faux', model: 'faux' }),
  });
  assert.equal(store.get(fresh.body.sessionId).agent, 'pi');
});

test('a resumed session accepts messages on its persistId', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json, base, faux } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    faux.setResponses([fauxAssistantMessage([fauxText('still here')])]);
    store.save({
      id: 'resume-me', adapter: 'pi', agent: 'pi', provider: 'faux', model: 'faux',
      cwd: '/tmp', messages: [{ role: 'user', content: 'earlier', timestamp: 1 }],
    });
    const created = await json('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ provider: 'faux', model: 'faux', persistId: 'resume-me' }),
    });
    assert.equal(created.status, 200);
    const r = await fetch(`${base}/sessions/resume-me/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ text: 'and now?' }),
    });
    assert.notEqual(r.status, 404, 'resumed ids are not lowercase-hex; UUID-only regex 404s them');
    await r.body.cancel();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 恢复会话时 POST /sessions 必须把找到的历史原样带回（前端据此渲染历史），
// 而记录不存在时必须 200 + resumed:false，id 仍是客户端给的 persistId——
// 不能让「没历史」表现成报错，否则前端会把一个可用会话当成创建失败。
// 变异验证：删掉响应里的 `messages` 或把 resumed 写死，本用例必红。
test('POST /sessions returns restored messages, or resumed:false when there is none', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    const seeded = [
      { role: 'user', content: 'earlier', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }], timestamp: 2 },
    ];
    store.save({ id: 'has-history', adapter: 'pi', agent: 'pi', messages: seeded });
    const ok = await json('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ provider: 'faux', model: 'faux', persistId: 'has-history' }),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.resumed, true);
    assert.deepEqual(ok.body.messages, seeded, 'restored history is in the response');

    const missing = await json('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ provider: 'faux', model: 'faux', persistId: 'gone-for-good' }),
    });
    assert.equal(missing.status, 200, 'a missing record is not an error');
    assert.equal(missing.body.resumed, false);
    assert.equal(missing.body.sessionId, 'gone-for-good', 'the client keeps its id');
    assert.equal(missing.body.messages, undefined, 'no fake empty history');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Task 6 补漏：配置字段必须真的落盘 ────────────────────────────────────────
//
// 上一批测试全在测试里手写 store.save({... provider:'faux' ...})，于是路由写对了、
// 列表查得到，但**生产路径从没写过这四个字段**（适配器只写自己那几样，网关
// 根本没调过 store.save）——真实一轮跑完，list(agent,cwd,provider,model) 恒 0 条。
// 这条测试自己跑一轮（真发消息、走适配器落盘），再查列表：端到端钉住
// 「真实一轮之后列表查得到」。
test('a real turn persists the fields the session list filters on', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json, base, faux } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    faux.setResponses([fauxAssistantMessage([fauxText('hi')])]);
    const created = await json('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ provider: 'faux', model: 'faux', cwd: '/tmp' }),
    });
    assert.equal(created.status, 200);
    const sessionId = created.body.sessionId;
    // 真跑一轮：走 /messages（SSE），让适配器也写它那几样（messages 等）
    const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ text: 'hi' }),
    });
    await res.text();
    const rec = store.get(sessionId);
    assert.ok(rec, 'session persisted on create');
    assert.equal(rec.provider, 'faux');
    assert.equal(rec.model, 'faux');
    assert.equal(rec.agent, 'pi');
    assert.equal(rec.cwd, '/tmp');
    assert.equal(rec.title, 'hi', 'title derived from the first user message');
    const listed = await json('/sessions?agent=pi&provider=faux&model=faux');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.sessions.some((s) => s.id === sessionId),
      'the list filter must actually match a real session');
    // piSessionDir 不在记录里（记录只存镜像文件 id），由网关在列表里补上：
    // UI 的「本机续接命令」拿它拼 --session-dir，缺了这条命令必然找不到会话。
    const listedPi = listed.body.sessions.find((s) => s.id === sessionId);
    assert.equal(listedPi.piSessionDir, piSessionDir(), 'pi records carry the mirror dir');
    // apiKey 绝不入盘
    assert.equal(rec.apiKey, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 有状态路由会往 store 里写东西：测试必须把 store 锁在临时目录里 ─────────────
//
// startServer 不注入 store 时会自建**开发者真实会话目录**的 store，而 POST
// /sessions 会真的往里写记录。这件事有过代价：早期 fixtures 没注入 store，
// 每跑一次测试就在真实目录里留下一批 cwd=null 的桩记录；更早的一版还会在启动时
// 无条件 sweep，把真实目录里超 7 天的会话删掉。所以：
//   ① 结构性守卫（下面第一条用例）——所有 startServer 调用点要么注入 store、
//      要么是专门测「默认 store」的那一条；
//   ② 合成复现——拿生产代码里**真实的写入表达式**（下面的 fields 与
//      src/server.mjs 中 POST /sessions 的 fields 逐字一致）对一批攻击性 body
//      跑一遍，断言落盘结果只含白名单字段、且 apiKey 永远进不去。
//
// 为什么不写成 HTTP 级用例：那会真的调用 startServer 默认 store，也就真的写进
// 开发者目录——等于用测试去复现被测试的那个 bug。注意：HTTP 级的那份 API key
// 保证由 store 的白名单提供，store 自己有一套往返测试钉着它。
test('every startServer call in the tests injects its own store', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs'));
  const offenders = [];
  for (const f of files) {
    const lines = readFileSync(join(here, f), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      // 跳过本文件里对 `startServer({` 字面量本身的引用
      const code = lines[i].replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
      if (!code.includes('startServer({')) continue;
      // 调用可能跨行：看这一个调用到 `});` 为止的整段
      const chunk = lines.slice(i, i + 12).join('\n').split('});')[0];
      if (!chunk.includes('transcripts')) offenders.push(`${f}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, [], 'a store-less startServer writes into the real ~/.config/agenttoolbox/sessions');
});

// 白名单能落盘的键，也能装凭据：provider/model 本该是字符串，传个对象进去
// 嵌套的 key 就进了 0600 文件。走真路由（不复制 server.mjs 里的字段表达式，
// 否则测试只钉住了副本），落盘检查 + 读回检查同时做。
test('POST /sessions never lets a credential or nested object onto disk', async (t) => {
  const store = mkStore(t);
  const { base } = await withFauxServer(t, ['http://localhost:4321'], async () => false, store);
  const post = (body) => fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify(body),
  });
  const bodies = [
    { provider: 'faux', model: 'faux', apiKey: 'sk-live-SECRET', cwd: '/tmp' },
    { provider: { apiKey: 'sk-nested' }, model: { env: { ANTHROPIC_API_KEY: 'sk-env' } } },
    { name: 'display-name', title: 'sneaky', messages: [{ role: 'user', content: 'x' }], createdAt: { apiKey: 'sk' } },
    { provider: 'faux', Authorization: 'Bearer sk', nested: { token: 'sk' } },
    { agent: 'pi', adapter: { id: 'pi', apiKey: 'sk' }, toolTier: ['full', 'sk'], cwd: ['/tmp', 'sk'] },
  ];
  for (const body of bodies) {
    const id = randomUUID();
    const r = await post({ adapter: 'pi', ...body, persistId: id });
    await r.body.cancel();
    assert.equal(r.status, 200, `POST failed for ${JSON.stringify(body)}`);
    const raw = readFileSync(join(store.dir, `${id}.json`), 'utf8');
    assert.ok(!raw.includes('sk'), `credential reached disk for ${JSON.stringify(body)}: ${raw}`);
    const rec = store.get(id);
    for (const k of ['apiKey', 'Authorization', 'title', 'messages', 'name', 'nested', 'createdAt']) {
      if (k === 'createdAt') assert.equal(typeof rec.createdAt, 'number', 'createdAt is stamped, never taken from the request');
      else assert.equal(rec[k], undefined, `${k} must not come from the request`);
    }
  }
  // 非真空：同一路由对合法字符串确实落盘 provider/model（否则上面「没有」是废话）
  const okId = randomUUID();
  const ok = await post({ adapter: 'pi', provider: 'faux', model: 'faux', persistId: okId });
  await ok.body.cancel();
  const okRec = store.get(okId);
  assert.equal(okRec.provider, 'faux');
  assert.equal(okRec.model, 'faux');
});

// 恢复一条已有记录时，请求里「每次都会带」的字段（前端固定发 toolTier，cwd
// 是当前界面状态）不能把记录自己的配置降级：一条 full 档的会话被以 none
// 打开，盘上就变成 none，下次从列表按 cwd/tier 找就对不上了。
test('restoring a record does not downgrade its own provider/model/cwd/toolTier', async (t) => {
  const store = mkStore(t);
  const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
  store.save({ id: 'full-one', adapter: 'pi', agent: 'pi', provider: 'zai', model: 'glm', cwd: '/tmp/proj', toolTier: 'full' });
  const r = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ adapter: 'pi', provider: 'faux', model: 'faux', toolTier: 'none', persistId: 'full-one' }),
  });
  assert.equal(r.status, 200);
  const rec = store.get('full-one');
  assert.equal(rec.provider, 'faux', 'what the run actually uses is recorded');
  assert.equal(rec.cwd, '/tmp/proj', 'no cwd in the request: keep the record\'s own');
  // 前端每次都发 toolTier；恢复时它是「这次运行用什么」的请求，不是对记录的
  // 声明——记录写的是「这条会话是怎么跑过的」，所以不覆盖。
  assert.equal(rec.toolTier, 'full', 'toolTier is not rewritten on restore');
});

// 用户原话：「切换模型后如果没有换 agent，那会话历史应该不变」。
// 模型/provider 曾是筛选四维中的两维（server.mjs 的 filter 构造处），于是从
// GLM 卡切到 Claude 卡历史整排消失。二者已从筛选里退出，仍是记录字段
// （展示用）。这条钉住网关行为，不是 store 能力。
test('switching models does not lose the history: the list is scoped by agent+cwd only', async (t) => {
  const store = mkStore(t);
  const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
  const msg = [{ role: 'user', content: 'hi', timestamp: 1 }];
  // 同一目录、同一 agent，两个不同模型各一条历史
  store.save({ id: 'by-glm', agent: 'pi', cwd: '/tmp/x', provider: 'zai', model: 'glm-4.7-flash', lastUsed: 1, messages: msg });
  store.save({ id: 'by-claude', agent: 'pi', cwd: '/tmp/x', provider: 'openrouter', model: 'claude-sonnet-5-5', lastUsed: 2, messages: msg });
  store.save({ id: 'other-cwd', agent: 'pi', cwd: '/tmp/y', provider: 'zai', model: 'glm-4.7-flash', lastUsed: 3, messages: msg });
  store.save({ id: 'other-agent', agent: 'cc', cwd: '/tmp/x', provider: 'zai', model: 'glm-4.7-flash', lastUsed: 4, messages: msg });

  // 现在选的是 Claude：按 model 筛的话只剩 by-claude，GLM 那条会消失。
  const r = await json('/sessions?agent=pi&cwd=%2Ftmp%2Fx&provider=openrouter&model=claude-sonnet-5-5');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sessions.map((s) => s.id).sort(), ['by-claude', 'by-glm'],
    'a model switch must not hide the history');
  assert.ok(!r.body.sessions.some((s) => s.id === 'other-cwd'), 'cwd is still a boundary');
  assert.ok(!r.body.sessions.some((s) => s.id === 'other-agent'), 'agent is still a boundary');

  // provider/model 仍写进记录，但降级为展示元数据：列表 payload 里看得见。
  const glm = r.body.sessions.find((s) => s.id === 'by-glm');
  assert.equal(glm.provider, 'zai', 'provider is still recorded');
  assert.equal(glm.model, 'glm-4.7-flash', 'model is still recorded (the list row labels it)');
});

// 清空按钮的标签写的是「清空此目录的历史」——改后它真的只按目录清，
// 不再偷偷多带一个模型条件。
test('clearing this directory clears every model under it', async (t) => {
  const store = mkStore(t);
  const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
  store.save({ id: 'a', agent: 'pi', cwd: '/tmp/x', provider: 'zai', model: 'glm-4.7-flash' });
  store.save({ id: 'b', agent: 'pi', cwd: '/tmp/x', provider: 'openrouter', model: 'claude-sonnet-5-5' });
  store.save({ id: 'c', agent: 'pi', cwd: '/tmp/y', provider: 'zai', model: 'glm-4.7-flash' });
  // 请求体仍带 provider/model（前端暂时没改）：必须被忽略，而不是筛掉 b。
  const r = await json('/sessions/clear', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ agent: 'pi', cwd: '/tmp/x', provider: 'zai', model: 'glm-4.7-flash' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.cleared, 2, 'both models under this cwd go');
  assert.ok(store.get('c'), 'a different cwd survives');
});

// 端到端：换模型后恢复的是同一条会话，且历史消息一起来了。
// 这是两个改动的交汇点——筛选降维（同目录跨模型可见）+ cc restore 读 jsonl。
// 用 fake-claude 夹具，不 spawn 真 CLI。
test('switching models resumes the same cc session, with its dialogue', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const registry = createRegistry([createCcAdapter({
      cliPath: join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude.sh'),
      transcripts: store,
    })]);
    const srv = await startServer({
      port: 0, allowedOrigins: ['http://localhost:4321'], registry,
      acpProbe: async () => false, transcripts: store,
    });
    t.after(() => srv.close());
    const base = `http://127.0.0.1:${srv.port}`;
    const json = async (path, opts = {}) => {
      const res = await fetch(base + path, { ...opts, headers: { Origin: 'http://localhost:4321', ...(opts.headers ?? {}) } });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    // 第一轮：用模型 A 建会话、发一轮，让 cc 适配器在 turn_end 写下 ccSessionId
    const first = await json('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter', model: 'm:free', agent: 'cc', cwd: '/tmp', toolTier: 'read' }),
    });
    assert.equal(first.status, 200);
    const id = first.body.sessionId;
    await fetch(`${base}/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ text: 'hi' }),
    }).then((r) => r.text());
    const rec = store.get(id);
    assert.equal(rec.ccSessionId, 'fake-sess-1', 'the first turn completed');

    // 种一份 CLI 的 jsonl：restore() 靠它把历史读出来
    mkdirSync(join(rec.configDir, 'projects', 'slug'), { recursive: true });
    writeFileSync(join(rec.configDir, 'projects', 'slug', 'fake-sess-1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n'
      + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: '想一下' }, { type: 'text', text: 'PONG' }] } }) + '\n');

    // 关掉第一个 server（= 重启网关）：活跃内存会话随它消失。不这么做的话
    // 第二次 POST /sessions 带 persistId 会命中 409「session already active」
    // ——两个标签页不能共用一份记录。真实流程里恢复本来就发生在重启/逐出后。
    await srv.close();
    // 用同一份 store 重启：记录（含 configDir/ccSessionId）在盘上，内存会话没了
    const srv2 = await startServer({
      port: 0, allowedOrigins: ['http://localhost:4321'], registry,
      acpProbe: async () => false, transcripts: store,
    });
    t.after(() => srv2.close());
    const base2 = `http://127.0.0.1:${srv2.port}`;
    const json2 = async (path, opts = {}) => {
      const res = await fetch(base2 + path, { ...opts, headers: { Origin: 'http://localhost:4321', ...(opts.headers ?? {}) } });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    // 换模型再进：模型 B。断言恢复的是**同一条**会话，且带着历史消息。
    const second = await json2('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openrouter', model: 'other:free', agent: 'cc', cwd: '/tmp',
        toolTier: 'read', persistId: id,
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.sessionId, id, 'the same session, not a new one');
    assert.equal(second.body.resumed, true, 'it really resumed');
    assert.deepEqual(second.body.messages, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: '想一下' }, { type: 'text', text: 'PONG' }] },
    ], 'the dialogue came back with it');
    // 模型是记录里的展示元数据：被更新成「最近一次用的」，不是筛选键。
    assert.equal(store.get(id).model, 'other:free', 'model is recorded, not filtered on');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 同一个标签页内换模型卡片：前端 openChat 造新 chat、作废旧 sessionId，但**不关抽屉**，
// 于是网关侧那条内存会话还活着。不释放的话第二次 POST /sessions{persistId} 命中
// server.mjs 的 409「session already active」，前端只能转开新对话——历史照样不出现
// （这正是用户原话「切换模型后会话历史应该不变」的实见路径，探针实测复现）。
// release 是这条路的出口：语义只有「这个标签页不再占用它」，磁盘记录与历史原样留着。
test('release frees the live session so a model switch can resume it', async (t) => {
  const store = mkStore(t);
  const { json, srv } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
  const msg = [{ role: 'user', content: 'hi', timestamp: 1 }];
  store.save({ id: 'live-one', adapter: 'pi', agent: 'pi', cwd: '/tmp', provider: 'zai', model: 'glm-4.7-flash', lastUsed: 1, messages: msg });

  // 先在模型 A 下把它开成活跃会话（= 用户此时正在这张卡里聊天）
  const a = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'pi', cwd: '/tmp', provider: 'zai', model: 'glm-4.7-flash', persistId: 'live-one' }),
  });
  assert.equal(a.status, 200);
  assert.equal(a.body.resumed, true);

  // 不释放就换模型：409，前端只能开新对话（历史不出现）
  const blocked = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'pi', cwd: '/tmp', provider: 'openrouter', model: 'claude-sonnet-5-5', persistId: 'live-one' }),
  });
  assert.equal(blocked.status, 409, 'the live session still blocks a resume');

  // release：只让出占用。记录和历史一个字不动。
  const rel = await json('/sessions/live-one/release', { method: 'POST' });
  assert.equal(rel.status, 204);
  assert.ok(store.get('live-one'), 'release keeps the record on disk');
  assert.deepEqual(store.get('live-one').messages, msg, 'release keeps the history');

  // 现在换模型恢复得了，且历史跟着一起回来
  const b = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'pi', cwd: '/tmp', provider: 'openrouter', model: 'claude-sonnet-5-5', persistId: 'live-one' }),
  });
  assert.equal(b.status, 200);
  assert.equal(b.body.sessionId, 'live-one', 'still the same session');
  assert.equal(b.body.resumed, true, 'it really resumed');
  assert.equal(b.body.messages?.length, 1, 'the dialogue came back with it');
  assert.equal(b.body.model, 'claude-sonnet-5-5', 'the new model is recorded');
});

// release 的边界：没在占用（从没建过 / 已逐出 / 重启后）→ 204 幂等。
// 前端在关抽屉、换 agent 等每条作废路径上都会发它，不能因为「已经不活跃了」报错——
// 那会让每条作废路径都多一个要忽略的失败。
test('release is idempotent for a session that is not active', async (t) => {
  const { json } = await withFauxServer(t, ['http://localhost:4321']);
  const r = await json('/sessions/never-existed/release', { method: 'POST' });
  assert.equal(r.status, 204);
});

// 非法 id 必须在门口就拦（它会被当磁盘文件名用），而不是走到 store 里抛 TypeError
// 被当成 500。与 DELETE 同一把尺子。
test('release rejects an unsafe id', async (t) => {
  const { json } = await withFauxServer(t, ['http://localhost:4321']);
  const r = await json('/sessions/..%2Fetc%2Fpasswd/release', { method: 'POST' });
  assert.ok(r.status === 400 || r.status === 404, `unsafe id rejected, got ${r.status}`);
});
