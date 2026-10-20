import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCcAdapter } from '../src/adapters/cc.mjs';
import { sanitizeChildEnv } from '../src/child-env.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude.sh');
const FLOOD_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude-stderr-flood.sh');
const HANG_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude-hang.sh');
const collect = async (iter) => { const out = []; for await (const e of iter) out.push(e); return out; };

// 迭代器超时保护：夹具若触发回归（stderr 未排空 / 缺终结事件未收尾），
// run() 会永久挂起；这里把「挂起」显式变成一次测试失败，而不是拖死整个套件。
const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

test('cc adapter streams deltas then turn_end', async () => {
  const cc = createCcAdapter({ cliPath: FIXTURE });
  const events = await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'x/y:free', apiKey: 'k', baseUrl: 'https://openrouter.ai/api',
    cwd: '/tmp', allowedTools: [],
  }));
  assert.deepEqual(events.map((e) => e.type), ['delta', 'turn_end']);
  assert.equal(events[0].text, 'PONG');
  assert.equal(events[1].sessionId, 'fake-sess-1');
});

test('cc adapter surfaces CLI errors', async () => {
  const cc = createCcAdapter({ cliPath: FIXTURE, env: { FAKE_CC_MODE: 'error' } });
  const events = await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [],
  }));
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /500 boom/);
});

test('cc adapter marks gate errors for routing fallback', async () => {
  const cc = createCcAdapter({ cliPath: FIXTURE, env: { FAKE_CC_MODE: 'gate' } });
  const events = await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [],
  }));
  assert.equal(events.at(-1).gate, true);
});

test('cc adapter availability reflects cli presence', async () => {
  assert.equal(await createCcAdapter({ cliPath: FIXTURE }).available(), true);
  assert.equal(await createCcAdapter({ cliPath: '/nonexistent/claude' }).available(), false);
});

// 回归：宿主 Claude Code 会话的运行时变量不得漏进网关 spawn 的 CLI。
// ENABLE_TOOL_SEARCH=true 会让 CLI 延后加载工具，OpenRouter 等非 Anthropic 兼容
// 端点直接报 "Deferred custom tools are only supported on Anthropic models..."。
test('sanitizeChildEnv strips host session vars without mutating input', () => {
  const input = {
    ENABLE_TOOL_SEARCH: 'true',
    CLAUDE_CODE_SESSION_ID: 'host-sess',
    CLAUDE_CODE_MESSAGING_SOCKET: '/run/cc.sock',
    CLAUDE_CODE_MESSAGING_TOKEN: 'tok',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_EXECPATH: '/x/claude',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_CODE_PROMPT_SUGGESTION: '0',
    PATH: '/usr/bin',
    ANTHROPIC_BASE_URL: 'https://api.example',
  };
  const out = sanitizeChildEnv(input);
  for (const key of ['ENABLE_TOOL_SEARCH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_PROMPT_SUGGESTION']) {
    assert.ok(!(key in out), `${key} stripped`);
  }
  assert.equal(out.PATH, '/usr/bin', 'unrelated vars kept');
  assert.equal(out.ANTHROPIC_BASE_URL, 'https://api.example', 'provider vars kept (overridden later)');
  assert.equal(input.ENABLE_TOOL_SEARCH, 'true', 'input not mutated');
});

test('cc adapter does not leak host session env into the CLI process', async () => {
  const saved = { ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_MESSAGING_SOCKET: process.env.CLAUDE_CODE_MESSAGING_SOCKET };
  process.env.ENABLE_TOOL_SEARCH = 'true';
  process.env.CLAUDE_CODE_SESSION_ID = 'host-sess';
  process.env.CLAUDE_CODE_MESSAGING_SOCKET = '/run/cc.sock';
  try {
    const cc = createCcAdapter({ cliPath: FIXTURE, env: { FAKE_CC_ECHO_ENV: '1', FAKE_CC_CONTROL: 'kept' } });
    const events = await collect(cc.run({
      messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [],
    }));
    const line = events.find((e) => e.type === 'delta');
    assert.ok(line, 'fixture echoed env');
    assert.match(line.text, /TS=unset/, 'ENABLE_TOOL_SEARCH not inherited by the CLI');
    assert.match(line.text, /SID=unset/, 'host session id not inherited');
    assert.match(line.text, /SOCK=unset/, 'host messaging socket not inherited');
    assert.match(line.text, /CTX=kept/, 'explicit adapter env still passes through');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('cc adapter isolates config from the user environment', async () => {
  const cc = createCcAdapter({ cliPath: FIXTURE, env: { FAKE_CC_ECHO_CONFIG: '1' } });
  const events = await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [],
  }));
  const line = events.find((e) => e.type === 'delta');
  assert.ok(line, 'fixture echoed config');
  assert.match(line.text, /atbx-cc-/);
  assert.doesNotMatch(line.text, /\.claude/);
});

// 回归：stderr 洪泛 + 零终结行。若有人删掉 child.stderr.resume()，子进程会阻塞在
// 写 stderr 上、'close' 永不触发，本用例超时失败；若有人删掉缺终结事件的收尾逻辑，
// 同样超时失败。正常时应在超时前 yield 一个合成的 error 事件。
test('cc adapter drains stderr and terminates without a terminal line', async () => {
  const cc = createCcAdapter({ cliPath: FLOOD_FIXTURE });
  const events = await withTimeout(
    collect(cc.run({
      messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [],
    })),
    15000,
    'stderr-flood fixture never terminated',
  );
  const last = events.at(-1);
  assert.equal(last.type, 'error');
  assert.match(last.message, /exited with code 7/);
});

// ── 生命周期：abort 与孤儿清理 ────────────────────────────────────────────────
// 这组测试直接断言子进程的存活状态——此前的审查之所以漏掉两个 blocker，
// 正是因为没有任何测试检查过子进程本身。

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const pidFilePath = (name) => join(tmpdir(), `atbx-cc-test-${process.pid}-${name}.pid`);
const waitForPid = async (file, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const pid = readFileSync(file, 'utf8').trim();
      if (pid) return Number(pid);
    } catch { /* 文件尚未写出 */ }
    await delay(50);
  }
  throw new Error(`fixture never wrote pidfile ${file} — did it start?`);
};
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
// 子进程收到 SIGTERM 到真正消失之间有个窗口，轮询等待即可。
const waitUntilDead = async (pid, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(50);
  }
  return false;
};

test('cc adapter kills the child when the turn is aborted', async () => {
  const pidFile = pidFilePath('abort');
  const ac = new AbortController();
  const cc = createCcAdapter({ cliPath: HANG_FIXTURE, env: { FAKE_PIDFILE: pidFile } });
  const iter = cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [],
    signal: ac.signal,
  });
  // 用 push 泵驱动消费：生成器会长期挂在 yield 上等消费者，此刻 abort 必须依然生效
  // （这正是此前 finally-only 清理覆盖不到的场景）。
  const events = [];
  const pump = (async () => {
    try { for await (const ev of iter) events.push(ev); } catch { /* 见下断言 */ }
  })();
  const pid = await waitForPid(pidFile);
  try {
    assert.ok(isAlive(pid), 'fixture should be running before abort');
    ac.abort();
    assert.ok(await waitUntilDead(pid), `child pid ${pid} still alive ${8000}ms after abort`);
    await withTimeout(pump, 10000, 'generator did not finish after abort');
  } finally {
    if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    try { await iter.return?.(); } catch { /* already finished */ }
    rmSync(pidFile, { force: true });
  }
});

test('cc adapter kills the child when the consumer stops early', async () => {
  const pidFile = pidFilePath('early');
  const cc = createCcAdapter({ cliPath: HANG_FIXTURE, env: { FAKE_PIDFILE: pidFile } });
  const iter = cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [],
  });
  let pid = null;
  try {
    // 注意：async generator 是惰性的，首次 next() 才会真正 spawn——所以必须在
    // 迭代过程中（拿到首个事件时）再读 pidfile，不能迭代前就等。
    for await (const ev of iter) {
      // 拿到首个事件就跳出：触发生成器 return() → finally → 进程组清理。
      if (ev.type === 'delta') { pid = await waitForPid(pidFile); break; }
    }
    assert.ok(pid, 'fixture never started');
    assert.ok(await waitUntilDead(pid), `child pid ${pid} survived an early consumer break`);
  } finally {
    if (pid && isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    try { await iter.return?.(); } catch { /* already finished */ }
    rmSync(pidFile, { force: true });
  }
});

// 不在本进程内 spawn，而是起一个子进程扮演网关：只有把它 SIGTERM 掉，才能观察到
// 「网关进程终止时子进程是否变孤儿」——在本进程内 kill 自己会连带整个测试运行器。
test('cc adapter leaves no orphan when the host process is terminated', async () => {
  const pidFile = pidFilePath('hostterm');
  const holder = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/cc-turn-holder.mjs');
  const gateway = spawn(process.execPath, [holder, HANG_FIXTURE, pidFile], { stdio: 'ignore' });
  let pid = null;
  try {
    pid = await waitForPid(pidFile);
    assert.ok(isAlive(pid), 'fixture should be running');
    gateway.kill('SIGTERM');
    // 先确认网关自己确实退出了——process.on('SIGTERM') 顶掉了 Node 的默认终止行为，
    // 若处理器忘记 process.exit，网关会「收到 SIGTERM 却赖着不死」，那比孤儿更糟。
    const gwDead = await waitUntilDead(gateway.pid, 8000);
    const childDead = await waitUntilDead(pid, 8000);
    assert.ok(gwDead, `gateway pid ${gateway.pid} ignored SIGTERM (handler must process.exit)`);
    assert.ok(childDead, `child pid ${pid} orphaned after host SIGTERM`);
  } finally {
    if (isAlive(gateway.pid)) { try { gateway.kill('SIGKILL'); } catch { /* already gone */ } }
    if (pid && isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    rmSync(pidFile, { force: true });
  }
});

// ── 跨 turn resume（用户实见症状）────────────────────────────────────────────
// 「点了 tool 让它干活，第一条正常，第二条立即报错」。根因：隔离
// CLAUDE_CONFIG_DIR 每轮新建并删除，而 claude --resume <id> 只在这个目录里找
// transcript（<dir>/projects/<slug>/<id>.jsonl）——全新空目录必然报
// "No conversation found with session ID: …"（CLI 2.1.302 实测）。
// 本用例是套件里唯一跑真实 claude CLI 的：用本地假上游喂它，既不打真实 API
// 也不外网。未装 CLI 的环境 skip，不让 CI 因环境缺失而红。
const startFakeAnthropic = async () => {
  const portFile = join(tmpdir(), `atbx-fake-upstream-${process.pid}-${Date.now()}.port`);
  const child = spawn(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-anthropic.mjs')],
    { env: { ...process.env, FAKE_ANTHROPIC_PORT_FILE: portFile }, stdio: 'ignore', detached: true },
  );
  let port = null;
  for (let i = 0; i < 60; i++) {
    try {
      const p = Number(readFileSync(portFile, 'utf8').trim());
      if (p) { port = p; break; }
    } catch { /* 夹具还没写完 */ }
    await delay(100);
  }
  if (!port) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ } throw new Error('fake upstream never reported a port'); }
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ } rmSync(portFile, { force: true }); },
  };
};

test('cc adapter keeps the isolated config dir across turns so --resume works', async (t) => {
  const hasCli = await createCcAdapter().available();
  if (!hasCli) { t.skip('claude CLI not installed'); return; }

  const upstream = await startFakeAnthropic();
  t.after(upstream.close);

  const cc = createCcAdapter();
  const cwd = mkdtempSync(join(tmpdir(), 'atbx-cc-resume-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const run = (resumeSessionId) => collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'claude-sonnet-4-5', apiKey: 'k', baseUrl: upstream.baseUrl, cwd, allowedTools: [],
    resumeSessionId, sessionId: 'sess-resume-1',
  }));

  const first = await withTimeout(run(null), 90000, 'first turn');
  const firstSid = first.find((e) => e.sessionId)?.sessionId;
  assert.ok(firstSid, 'first turn reports a session id');
  assert.equal(first.at(-1).type, 'turn_end', 'first turn should complete');

  const second = await withTimeout(run(firstSid), 90000, 'second turn');
  assert.equal(second.at(-1).type, 'turn_end', `second turn errored: ${second.at(-1).message}`);
  // resume 成功时 CLI 复用同一个 session_id（实测 2.1.302 行为）
  assert.equal(second.find((e) => e.sessionId)?.sessionId, firstSid, 'resumed turn reuses the session id');
});

// 会话终结时适配器必须回收隔离目录：否则一次浏览器会话就永久泄漏一个
// CLAUDE_CONFIG_DIR（含用户这一会话的 transcript）。
test('cc adapter disposeSession reclaims the isolated config dir', async () => {
  const cc = createCcAdapter({ cliPath: FIXTURE, env: { FAKE_CC_ECHO_CONFIG: '1' } });
  const events = await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [], sessionId: 'sess-dispose-1',
  }));
  const dir = events.find((e) => e.type === 'delta')?.text?.match(/CFG=(\S+)/)?.[1];
  assert.ok(dir, 'fixture echoed the config dir');
  assert.ok(existsSync(dir), 'dir still present after the turn (needed for --resume)');
  cc.disposeSession('sess-dispose-1');
  assert.ok(!existsSync(dir), 'disposeSession removed the dir');
});
