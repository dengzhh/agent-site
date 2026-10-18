// cc 权限转发（Task 11，stream-json 控制通道路径）：假 CC 夹具在回合中点发
// control_request(can_use_tool)，断言适配器把它转发到 requestApproval（抽屉），
// 并按答复回写协议精确形状的 control_response。
//
// 机制选型依据（实测，非占位）：claude CLI 2.1.302 的 --permission-prompt-tool 是
// 唯一的权限路由槽位——取值字面量 'stdio'（stream-json 控制通道）或某个 --mcp-config
// 里的 MCP 工具名，二者互斥（CLI/SDK 对同时配置直接报错 "canUseTool callback cannot
// be used with permissionPromptToolName. Please use one or the other."）。官方 SDK 的
// canUseTool 回调正是用 --permission-prompt-tool stdio 实现的，故控制通道即第一方
// 机制：进程内、零额外进程与共享密钥。MCP 桥（cc-perm-bridge.mjs）因此暂缓——
// 见 plan Task 11 的决策记录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCcAdapter } from '../src/adapters/cc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PERM_FIXTURE = join(HERE, 'fixtures/fake-claude-perm.mjs');
const ARGV_FIXTURE = join(HERE, 'fixtures/cc-echo-argv.sh');

const collect = async (iter) => { const out = []; for await (const e of iter) out.push(e); return out; };
// 夹具回归（如权限应答写不回去）会表现为挂起：显式超时变失败，不拖死套件。
const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};
// 夹具把收到的 control_response 原样回显为 "RESP=<行>" delta，测试据此断言线上帧。
const respDelta = (events) => {
  const ev = events.find((e) => e.type === 'delta' && e.text?.startsWith('RESP='));
  return ev ? JSON.parse(ev.text.slice(5)) : null;
};
// SSE 逐帧读取器：返回 data: 块里的 JSON；流结束返回 null。
const sseReader = (res) => {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  return async () => {
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
};
const baseRun = (over = {}) => ({
  messages: [{ role: 'user', content: 'clean up' }], model: 'm', apiKey: 'k',
  baseUrl: 'https://x/api', cwd: '/tmp', allowedTools: [],
  ...over,
});

test('full tier: can_use_tool is forwarded to requestApproval and answered allow on the wire', async () => {
  const calls = [];
  const cc = createCcAdapter({ cliPath: PERM_FIXTURE });
  const events = await withTimeout(collect(cc.run(baseRun({
    toolTier: 'full',
    requestApproval: async (action, summary) => { calls.push({ action, summary }); return true; },
  }))), 15000, 'perm allow turn never finished');

  // 抽屉卡收到的动作与人类可读摘要
  assert.deepEqual(calls, [{ action: 'Bash', summary: 'Bash rm -rf /tmp/x' }]);

  // 回写 CC 的线上帧：官方 SDK 的精确形状（request_id 对齐 + allow 带 updatedInput）
  assert.deepEqual(respDelta(events), {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'perm-1',
      response: { behavior: 'allow', updatedInput: { command: 'rm -rf /tmp/x' }, toolUseID: 'tu-1' },
    },
  });
  // 夹具按 behavior 收尾：回合正常完成
  assert.ok(events.some((e) => e.type === 'delta' && e.text === 'allowed'));
  assert.equal(events.at(-1).type, 'turn_end');
});

test('full tier: deny answer flows back as behavior deny with a message', async () => {
  const cc = createCcAdapter({ cliPath: PERM_FIXTURE });
  const events = await withTimeout(collect(cc.run(baseRun({
    toolTier: 'full',
    requestApproval: async () => false,
  }))), 15000, 'perm deny turn never finished');

  const wire = respDelta(events);
  assert.equal(wire.response.request_id, 'perm-1');
  assert.equal(wire.response.response.behavior, 'deny');
  assert.equal(typeof wire.response.response.message, 'string');
  assert.ok(wire.response.response.message.length > 0);
  assert.ok(events.some((e) => e.type === 'delta' && e.text === 'denied'));
  assert.equal(events.at(-1).type, 'turn_end');
});

// fail-closed（与 Task 10 的 requestApproval 缺省拒绝同一约定）：full 级别直调 run()
// 而没有审批闸时，绝不能静默放行——每次 can_use_tool 都按拒绝应答。
test('full tier without requestApproval fails closed (auto-deny on the wire)', async () => {
  const cc = createCcAdapter({ cliPath: PERM_FIXTURE });
  const events = await withTimeout(collect(cc.run(baseRun({ toolTier: 'full' }))), 15000, 'perm fail-closed turn never finished');

  const wire = respDelta(events);
  assert.equal(wire.response.response.behavior, 'deny');
  assert.match(wire.response.response.message, /approval gate unavailable/);
  assert.ok(events.some((e) => e.type === 'delta' && e.text === 'denied'));
});

// 回归（Task 4 语义保持）：read 级别继续走 --allowedTools 只读三件套（三件套由
// server.mjs 计算并传入），适配器不得追加 stream-json 输入与权限提示工具。
test('read tier keeps the read-only allowedTools argv and adds no permission flags', async () => {
  const cc = createCcAdapter({ cliPath: ARGV_FIXTURE });
  const events = await collect(cc.run(baseRun({
    allowedTools: ['Read', 'Grep', 'Glob'],
    toolTier: 'read',
    requestApproval: async () => { throw new Error('read tier must not consult the approval gate'); },
  })));
  const args = events.filter((e) => e.type === 'delta').map((e) => e.text);
  const idx = args.indexOf('ARG=--allowedTools');
  assert.ok(idx !== -1, '--allowedTools present');
  assert.equal(args[idx + 1], 'ARG=Read,Grep,Glob');
  assert.ok(!args.some((a) => a.startsWith('ARG=--input-format')), 'no stream-json input at read tier');
  assert.ok(!args.some((a) => a.startsWith('ARG=--permission-prompt-tool')), 'no prompt tool at read tier');
});

test('full tier argv enables stream-json input and the stdio prompt tool', async () => {
  const cc = createCcAdapter({ cliPath: ARGV_FIXTURE });
  const events = await collect(cc.run(baseRun({ toolTier: 'full', requestApproval: async () => true })));
  const args = events.filter((e) => e.type === 'delta').map((e) => e.text);
  const fi = args.indexOf('ARG=--input-format');
  assert.ok(fi !== -1, '--input-format present');
  assert.equal(args[fi + 1], 'ARG=stream-json');
  const pt = args.indexOf('ARG=--permission-prompt-tool');
  assert.ok(pt !== -1, '--permission-prompt-tool present');
  assert.equal(args[pt + 1], 'ARG=stdio');
  const at = args.indexOf('ARG=--allowedTools');
  assert.ok(at !== -1);
  assert.equal(args[at + 1], 'ARG=', 'no tool is pre-allowed at full tier — tool calls that CC\'s policy doesn\'t auto-allow go through the drawer');
});

// 网关级往返：真实 server（Task 9 权限中枢）+ 真实 cc 适配器 + 假 CC 夹具。
// SSE permission_request 帧 → POST /permission 应答 → 控制通道回写 → 回合完成。
test('gateway roundtrip: drawer approval answers the cc control channel', async (t) => {
  // 与 server.test.mjs 相同的配置重定向（config.mjs 在 import 时求值默认路径）
  process.env.ATBX_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), 'atbx-cc-perm-')), 'config.json');
  const { startServer } = await import('../src/server.mjs');
  const { createRegistry } = await import('../src/adapters/registry.mjs');

  const registry = createRegistry([createCcAdapter({ cliPath: PERM_FIXTURE })]);
  const srv = await startServer({
    port: 0, allowedOrigins: ['http://localhost:4321'], registry, acpProbe: async () => false,
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text(), res };
  };

  const create = await post('/sessions', { provider: 'x', model: 'm', agent: 'cc', cwd: '/tmp', toolTier: 'full' });
  assert.equal(create.status, 200);
  const { sessionId } = create.body;

  const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'clean up' }),
  });
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

  const req = await next();
  assert.equal(req.type, 'permission_request');
  assert.match(req.reqId, /^[0-9a-f-]{36}$/);
  assert.equal(req.action, 'Bash');
  assert.equal(req.summary, 'Bash rm -rf /tmp/x');

  const ans = await post(`/sessions/${sessionId}/permission`, { reqId: req.reqId, decision: 'allow' });
  assert.equal(ans.status, 200);

  // 夹具回显适配器写出的线上帧 + 按 behavior 收尾
  const echo = await next();
  assert.equal(echo.type, 'delta');
  const wire = JSON.parse(echo.text.slice('RESP='.length));
  assert.equal(wire.type, 'control_response');
  assert.equal(wire.response.response.behavior, 'allow');
  assert.equal(wire.response.response.updatedInput.command, 'rm -rf /tmp/x');
  assert.deepEqual(await next(), { type: 'delta', text: 'allowed' });
  assert.equal((await next()).type, 'turn_end');
  assert.equal((await next()).type, 'done');
  assert.equal(srv.sessions.peek(sessionId).pendingPerms.size, 0, 'approval drained');
});

// 回归（真实 CLI 2.1.302 实测）：真 CLI 发完 result 后并不退出，而是握着 stdin 继续存活
// 直到 stdin EOF（现有夹具的立即 process.exit 掩盖了这一点）。交互模式若拖到生成器
// finally 才 end stdin，stdout 的 for-await 就永不结束 → run() 挂死 → SSE 没有 done 帧
// → 会话永久 streaming，后续 /messages 全部 409。夹具用 FAKE_CLAUDE_STAY=1 复刻该行为，
// 并要求回合在 2s 内走到 done（夹具收尾开销 ~400ms），然后同一会话可立即再开一回合。
test('gateway roundtrip: stay-alive CLI still reaches done and frees the session', async (t) => {
  // 与 server.test.mjs 相同的配置重定向（config.mjs 在 import 时求值默认路径）；
  // 测试自建的配置目录随手回收，不在 /tmp 留垃圾。
  const configDir = mkdtempSync(join(tmpdir(), 'atbx-cc-stay-'));
  process.env.ATBX_CONFIG_PATH = join(configDir, 'config.json');
  const { startServer } = await import('../src/server.mjs');
  const { createRegistry } = await import('../src/adapters/registry.mjs');

  const registry = createRegistry([createCcAdapter({ cliPath: PERM_FIXTURE, env: { FAKE_CLAUDE_STAY: '1' } })]);
  const srv = await startServer({
    port: 0, allowedOrigins: ['http://localhost:4321'], registry, acpProbe: async () => false,
  });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text(), res };
  };
  let sessionId = null;
  // 先 abort 再 close：红相位（挂死回归）时回合还悬着，不 abort 则 server.close()
  // 会等这条 SSE 永远等下去；绿相位里 abort 已是幂等无害的 no-op。
  t.after(async () => {
    if (sessionId) await post(`/sessions/${sessionId}/abort`).catch(() => {});
    await srv.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  const create = await post('/sessions', { provider: 'x', model: 'm', agent: 'cc', cwd: '/tmp', toolTier: 'full' });
  assert.equal(create.status, 200);
  sessionId = create.body.sessionId;

  const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'clean up' }),
  });
  const next = sseReader(res);

  const consume = (async () => {
    const req = await next();
    assert.equal(req.type, 'permission_request');
    assert.match(req.reqId, /^[0-9a-f-]{36}$/);
    const ans = await post(`/sessions/${sessionId}/permission`, { reqId: req.reqId, decision: 'allow' });
    assert.equal(ans.status, 200);
    const echo = await next();
    assert.equal(echo.type, 'delta');
    assert.match(echo.text, /^RESP=/);
    assert.deepEqual(await next(), { type: 'delta', text: 'allowed' });
    // turn_end 必须先于 done
    assert.equal((await next()).type, 'turn_end');
    assert.equal((await next()).type, 'done');
  })();
  try {
    // 有界时间护栏：挂死回归（result 后等不到 done）在这里 ~2s 失败，而不是拖死套件
    await withTimeout(consume, 2000, 'stay-alive turn never reached done (stdin not ended at result?)');
  } catch (err) {
    consume.catch(() => {}); // 超时后 consume 仍悬在 next() 上：其后续失败不再二次上报
    throw err;
  }

  // done 已到 → session.streaming 必须已复位：同一会话立即再开一回合，不得 409。
  const second = await fetch(`${base}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'again' }),
  });
  assert.equal(second.status, 200, `second turn must not 409 after done (streaming stuck): ${JSON.stringify(second.headers)}`);
  assert.match(second.headers.get('content-type') ?? '', /text\/event-stream/);
  // 第二回合的权限请求无人应答：立即中止（别等夹具 15s 超时），等 streaming 复位收尾。
  assert.equal((await post(`/sessions/${sessionId}/abort`)).status, 204);
  for (let i = 0; i < 100 && srv.sessions.peek(sessionId)?.streaming; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(srv.sessions.peek(sessionId).streaming, false, 'second turn aborted cleanly');
});
