import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCcAdapter } from '../src/adapters/cc.mjs';
import { TranscriptStore } from '../src/transcripts.mjs';
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
  const gateway = spawn(process.execPath, [holder, HANG_FIXTURE, pidFile, 'sess-hostterm'], { stdio: 'ignore' });
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

  // 目录的生存期如今跟随 transcript 记录（磁盘），必须传 store——不传的目录
  // 无主，turn 结束即删，resume 自然失败（这正是旧行为的回归）。
  const store = mkStore(t);
  const cc = createCcAdapter({ transcripts: store });
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

// 同一症状、无 store 的后备路径：server.mjs 目前正是这条路（还没接 store），
// 后备 Map 必须让同一 sessionId 的目录跨 turn 存活，否则 --resume 照样失败。
// 删掉后备 Map 或把后备目录改回「turn 结束即删」，这个用例立刻红。
test('cc adapter keeps the config dir across turns without a store so --resume works', async (t) => {
  const hasCli = await createCcAdapter().available();
  if (!hasCli) { t.skip('claude CLI not installed'); return; }

  const upstream = await startFakeAnthropic();
  t.after(upstream.close);

  const cc = createCcAdapter();
  const cwd = mkdtempSync(join(tmpdir(), 'atbx-cc-resume-nostore-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const run = (resumeSessionId) => collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'claude-sonnet-4-5', apiKey: 'k', baseUrl: upstream.baseUrl, cwd, allowedTools: [],
    resumeSessionId, sessionId: 'sess-resume-2',
  }));

  const first = await withTimeout(run(null), 90000, 'first turn (no store)');
  const firstSid = first.find((e) => e.sessionId)?.sessionId;
  assert.ok(firstSid, 'first turn reports a session id');
  assert.equal(first.at(-1).type, 'turn_end', 'first turn should complete');

  const second = await withTimeout(run(firstSid), 90000, 'second turn (no store)');
  assert.equal(second.at(-1).type, 'turn_end', `second turn errored: ${second.at(-1).message}`);
  assert.equal(second.find((e) => e.sessionId)?.sessionId, firstSid, 'resumed turn reuses the session id');
});

// 一次性调用（没给 sessionId）：目录无主，turn 结束即删，不留泄漏。
// 注意带 sessionId 的目录即使无 store 也跨 turn 保留——见下面的后备路径用例。
test('cc adapter turn end reclaims the dir of a sessionless call', async () => {
  const cc = createCcAdapter({ cliPath: FIXTURE, env: { FAKE_CC_ECHO_CONFIG: '1' } });
  const events = await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [],
  }));
  const dir = events.find((e) => e.type === 'delta')?.text?.match(/CFG=(\S+)/)?.[1];
  assert.ok(dir, 'fixture echoed the config dir');
  assert.ok(!existsSync(dir), 'unowned dir removed at turn end');
});

// ── 无 store 的后备路径（server.mjs 现行走的路）──────────────────────────────
// 没有 transcript 记录可挂时，目录挂在进程内的 fallbackDirs：同一 sessionId
// 的后续 turn 复用它，--resume 才找得到 transcript。这是 0.5.2 修好的行为，
// 一次性删掉它线上会立刻回到「第 2 条消息报错」，故必须有自己的覆盖。
test('cc adapter without a store reuses one dir per session across turns', async () => {
  const cc = createCcAdapter({ cliPath: FIXTURE, env: { FAKE_CC_ECHO_CONFIG: '1' } });
  const run = () => collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [], sessionId: 'sess-fb-1',
  }));
  const first = await run();
  const dir = first.find((e) => e.type === 'delta')?.text?.match(/CFG=(\S+)/)?.[1];
  assert.ok(dir, 'fixture echoed the config dir');
  assert.ok(existsSync(dir), 'dir kept after the turn (needed for --resume)');
  const second = await run();
  assert.equal(second.find((e) => e.type === 'delta')?.text?.match(/CFG=(\S+)/)?.[1], dir,
    'second turn reuses the same dir');
  assert.ok(existsSync(dir), 'dir still alive after the second turn');
  // 会话终结：目录只挂在内存缓存里，会话一逐出它就成了没人再引用的孤儿，
  // 此刻删（等价 0.5.2 的 dropConfigDir）。
  cc.disposeSession('sess-fb-1');
  assert.ok(!existsSync(dir), 'disposeSession reclaimed the fallback dir');
  // 逐出后再来一个同 id 的 turn：新建目录，而不是拿到已删目录的引用。
  const third = await run();
  assert.notEqual(third.find((e) => e.type === 'delta')?.text?.match(/CFG=(\S+)/)?.[1], dir,
    'after eviction a fresh dir is created');
  cc.disposeSession('sess-fb-1');
});

// ── 持久化：config dir 的生存期跟随 transcript 记录 ──────────────────────────
// 目录不再由内存 Map 管（重启即忘），而是记进 TranscriptStore：重启 / LRU 逐出后
// 下一轮 turn 仍能 --resume。dispose 只做内存收尾，绝不删记录或目录——
// 被逐出的会话历史正是「重启后还能恢复」的那份，删了本任务就白做了。

const mkStore = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new TranscriptStore({ dir });
};

test('cc adapter persists ccSessionId and config dir into the transcript store', async (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  const events = await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [], sessionId: 'sess-cc-1',
  }));
  assert.equal(events.at(-1).type, 'turn_end');
  const rec = store.get('sess-cc-1');
  assert.equal(rec.ccSessionId, 'fake-sess-1', 'ccSessionId persisted');
  assert.equal(rec.adapter, 'cc');
  assert.ok(existsSync(rec.configDir), 'config dir on disk');
  // fixture CLI 不写 projects/ 下的 transcript，plant 一个再验 restore：
  // 强校验要求文件真的在，restore 才肯说「可恢复」。
  mkdirSync(join(rec.configDir, 'projects', 'fake-slug'), { recursive: true });
  writeFileSync(join(rec.configDir, 'projects', 'fake-slug', 'fake-sess-1.jsonl'), '{}\n');
  const restored = cc.restore('sess-cc-1');
  assert.deepEqual(restored, { configDir: rec.configDir, ccSessionId: 'fake-sess-1' });
});

test('cc adapter restore returns null when the config dir is gone', (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  store.save({ id: 'sess-cc-2', adapter: 'cc', ccSessionId: 'x', configDir: join(tmpdir(), 'gone-xyz') });
  assert.equal(cc.restore('sess-cc-2'), null);
  // 记录缺字段同样不可恢复
  store.save({ id: 'sess-cc-2b', adapter: 'cc', configDir: tmpdir() });
  assert.equal(cc.restore('sess-cc-2b'), null);
});

test('cc adapter disposeSession keeps the record and its config dir', async (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  const events = await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [], sessionId: 'sess-cc-3',
  }));
  assert.equal(events.at(-1).type, 'turn_end');
  const dir = store.get('sess-cc-3').configDir;
  cc.disposeSession('sess-cc-3');
  assert.ok(store.get('sess-cc-3'), 'record survives eviction');
  assert.ok(existsSync(dir), 'config dir survives eviction');
});

// 目录的位置与权限是安全属性：必须落在 store 自己的 <id>.cc/ 里（remove() 才
// 能一并收走），mode 必须 0700。改成 mkdtemp / mode 0o755 都算回归。
test('cc adapter puts the config dir in the store at mode 0700', async (t) => {
  const { statSync } = await import('node:fs');
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [], sessionId: 'sess-cc-7',
  }));
  const rec = store.get('sess-cc-7');
  assert.equal(rec.configDir, store.companionDir('sess-cc-7'), 'config dir is the store companion dir');
  assert.equal(statSync(rec.configDir).mode & 0o777, 0o700, 'dir mode is 0700');
});

// R3（逐字段合并的另一半）：适配器写记录只许碰自己的三个字段，cwd/provider/
// model/toolTier 是 server 记的，绝不能被适配器覆盖或清空。
test('cc adapter persisting does not clobber server-owned record fields', async (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  store.save({
    id: 'sess-cc-8', adapter: 'cc', agent: 'cc',
    cwd: '/home/user/proj', provider: 'openrouter', model: 'x/y:free', toolTier: 'full',
  });
  await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [], sessionId: 'sess-cc-8',
  }));
  const rec = store.get('sess-cc-8');
  assert.equal(rec.cwd, '/home/user/proj', 'cwd untouched');
  assert.equal(rec.provider, 'openrouter', 'provider untouched');
  assert.equal(rec.model, 'x/y:free', 'model untouched');
  assert.equal(rec.toolTier, 'full', 'toolTier untouched');
});

// 失败/被闸的回合不得盖掉上一个好 id：CLI 在失败时也常带 sessionId，拿它
// 覆盖等于把还能 resume 的会话废掉。要测的就是「persist 的窄化」本身，所以
// 先 plant 一个真实 transcript（fixture 不写盘），保证 revive 不触发、记录
// 里的好 id 原封不动地进入失败回合。
test('cc adapter does not overwrite ccSessionId on an errored turn', async (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  // 先来一个成功回合，落下好 id
  await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [], sessionId: 'sess-cc-9',
  }));
  const dir = store.get('sess-cc-9').configDir;
  assert.equal(store.get('sess-cc-9').ccSessionId, 'fake-sess-1');
  // plant transcript：fixture 不写盘，不 plant 的话下一回合会走 revive（新目录
  // + 清 id），那就成了在测 revive 而不是 persist 的窄化。
  mkdirSync(join(dir, 'projects', 'fake-slug'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'fake-slug', 'fake-sess-1.jsonl'), '{}\n');
  // 再来一个失败回合（fixture 的 error 分支仍报 fake-sess-1）
  const errCc = createCcAdapter({ cliPath: FIXTURE, env: { FAKE_CC_MODE: 'error' }, transcripts: store });
  const events = await collect(errCc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [], sessionId: 'sess-cc-9',
  }));
  assert.equal(events.at(-1).type, 'error');
  assert.equal(store.get('sess-cc-9').ccSessionId, 'fake-sess-1', 'good id survived the failed turn');
  assert.equal(store.get('sess-cc-9').configDir, dir, 'config dir untouched');
});

// revive 的一种：旧 configDir 指向的目录整个没了。同一 sessionId 再跑一回合，
// 适配器必须新建目录、落盘新路径、清掉旧 ccSessionId——而不是拿着旧 id 对
// 着空目录 --resume（必报 "No conversation found"）。
test('cc adapter revive creates a fresh dir and clears a stale ccSessionId', async (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, env: { FAKE_CC_ECHO_CONFIG: '1' }, transcripts: store });
  store.save({ id: 'sess-cc-4', adapter: 'cc', ccSessionId: 'old-id', configDir: join(tmpdir(), 'atbx-cc-gone-4') });
  const events = await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [], sessionId: 'sess-cc-4',
  }));
  const dir = events.find((e) => e.type === 'delta')?.text?.match(/CFG=(\S+)/)?.[1];
  assert.ok(dir && existsSync(dir), 'fresh dir created for the turn');
  const rec = store.get('sess-cc-4');
  assert.equal(rec.configDir, dir, 'new dir recorded');
  assert.equal(rec.ccSessionId, 'fake-sess-1', 'turn-end persisted the fresh id');
  // 而在 revive 那一刻（save 落盘后、turn 终结前）旧 id 必须已被清掉：
  // 用一个不产生终结事件的 CLI 重跑，观察中间态。
  const cc2 = createCcAdapter({ cliPath: HANG_FIXTURE, transcripts: store });
  const iter = cc2.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [], sessionId: 'sess-cc-4',
  });
  await iter.next(); // 触发 configDirFor（此刻 revive 已发生），随后夹具挂住
  try {
    assert.equal(store.get('sess-cc-4').ccSessionId, null, 'stale id cleared before any terminal event');
    assert.equal(cc2.restore('sess-cc-4'), null, 'not restorable until a turn succeeds');
  } finally {
    try { await iter.return?.(); } catch { /* 已结束 */ }
  }
});

// revive 的另一种：目录还在，但里面没有 <ccSessionId>.jsonl（transcript 被
// 手删 / 目录被清）。同样必须重开新目录并清 id，不能拿旧 id 对着空目录 resume。
test('cc adapter revive when the recorded transcript file is gone', async (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, env: { FAKE_CC_ECHO_CONFIG: '1' }, transcripts: store });
  const staleDir = mkdtempSync(join(tmpdir(), 'atbx-cc-stale-'));
  t.after(() => rmSync(staleDir, { recursive: true, force: true }));
  mkdirSync(join(staleDir, 'projects', 'some-slug'), { recursive: true });
  store.save({ id: 'sess-cc-6', adapter: 'cc', ccSessionId: 'vanished-id', configDir: staleDir });
  const events = await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [], sessionId: 'sess-cc-6',
  }));
  const dir = events.find((e) => e.type === 'delta')?.text?.match(/CFG=(\S+)/)?.[1];
  assert.notEqual(dir, staleDir, 'a fresh dir replaced the transcript-less one');
  const rec = store.get('sess-cc-6');
  assert.equal(rec.configDir, dir, 'configDir updated on disk');
  assert.equal(rec.ccSessionId, 'fake-sess-1', 'fresh id persisted at turn end');
});

// restore 的强校验：configDir 在而 projects/ 下没有 <ccSessionId>.jsonl 时，
// --resume 必然失败（"No conversation found"），restore 不得谎报可恢复。
test('cc adapter restore returns null when the transcript file is missing', (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-empty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'projects', 'some-slug'), { recursive: true });
  store.save({ id: 'sess-cc-5', adapter: 'cc', ccSessionId: 'absent-id', configDir: dir });
  assert.equal(cc.restore('sess-cc-5'), null, 'no <id>.jsonl under projects/ → not restorable');
  writeFileSync(join(dir, 'projects', 'some-slug', 'absent-id.jsonl'), '{}\n');
  assert.deepEqual(cc.restore('sess-cc-5'), { configDir: dir, ccSessionId: 'absent-id' });
});

test('cc adapter restore returns null without a store', () => {
  const cc = createCcAdapter({ cliPath: FIXTURE });
  assert.equal(cc.restore('sess-whatever'), null);
});

// ── 进程退出兜底与目录生存期（R9）────────────────────────────────────────────
// store 记录指向的 config dir 必须跨 SIGTERM 存活——它承载着重启后恢复所需
// 的 transcript，被兜底误删等于又回到「重启后 resume 失败」。
test('cc adapter leaves store-owned config dirs intact when the host process exits', async () => {
  const holder = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/cc-turn-holder.mjs');
  const storeDir = mkdtempSync(join(tmpdir(), 'atbx-cc-r9-store-'));
  const pidFile = pidFilePath('r9');
  const gateway = spawn(process.execPath, [holder, HANG_FIXTURE, pidFile, 'sess-r9', storeDir], { stdio: 'ignore' });
  let pid = null;
  try {
    pid = await waitForPid(pidFile);
    // companion dir 在 spawn 前就已由 configDirFor 落盘，此刻必然存在
    assert.ok(existsSync(join(storeDir, 'sess-r9.cc')), 'companion dir exists before exit');
    gateway.kill('SIGTERM');
    const gwDead = await waitUntilDead(gateway.pid, 8000);
    if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    assert.ok(gwDead, `gateway pid ${gateway.pid} ignored SIGTERM`);
    assert.ok(existsSync(join(storeDir, 'sess-r9.cc')), 'store-owned config dir survives process exit');
  } finally {
    if (isAlive(gateway.pid)) { try { gateway.kill('SIGKILL'); } catch { /* already gone */ } }
    if (pid && isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    rmSync(pidFile, { force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

// ── restore 把 CLI 的对话读回来（2026-10-23）───────────────────────────────
// cc 的历史在 CLI 自己的 projects/<slug>/<id>.jsonl 里，我们的记录只有指针。
// restore() 读它，经 POST /sessions 已有的 material.messages 契约交出去，
// 网页于是能画出思维链 + 正文。判据是行首 type（user/assistant）——
// 实测噪声行（api-request-blob 之类）也带 message.role，按 role 筛会把
// 8474 字符的 system prompt 当用户消息渲染出来。

// 造一个假 configDir + 一份最小 jsonl。行序即真实对话序。
const plantTranscript = (dir, sessionId, lines) => {
  mkdirSync(join(dir, 'projects', 'fake-slug'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'fake-slug', `${sessionId}.jsonl`), lines.join('\n') + '\n');
};

const DIALOGUE_LINES = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '写一个贪吃蛇' }] } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: '先想清楚游戏循环' },
    { type: 'text', text: '好的，我来写。' },
  ] } }),
];

test('cc restore reads the dialogue out of the CLI jsonl', (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  plantTranscript(dir, 'sess-x', [
    ...DIALOGUE_LINES,
    // 噪声：attachment 没有 message；api-request-blob 带 message.role —— 按 role 筛会中招
    JSON.stringify({ type: 'attachment', attachment: { type: 'x' } }),
    JSON.stringify({ type: 'api-request-blob', message: { role: 'user', content: 'x'.repeat(8474) } }),
    JSON.stringify({ type: 'queue-operation', operation: 'add' }),
  ]);
  store.save({ id: 'sess-x', adapter: 'cc', ccSessionId: 'sess-x', configDir: dir });

  const restored = cc.restore('sess-x');
  assert.deepEqual(restored.messages, [
    { role: 'user', content: [{ type: 'text', text: '写一个贪吃蛇' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '先想清楚游戏循环' },
      { type: 'text', text: '好的，我来写。' },
    ] },
  ], 'only the dialogue lines, blocks passed through verbatim');
  // 指针照旧给：下一轮 --resume 仍要靠它们。
  assert.equal(restored.ccSessionId, 'sess-x');
  assert.equal(restored.configDir, dir);
});

// 按 role 筛的回归防线：噪声行同样带 role。
test('cc restore ignores noise lines that also carry a role', (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  plantTranscript(dir, 'sess-y', [
    JSON.stringify({ type: 'api-request-blob', message: { role: 'user', content: 'system prompt…' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
  ]);
  store.save({ id: 'sess-y', adapter: 'cc', ccSessionId: 'sess-y', configDir: dir });
  assert.deepEqual(cc.restore('sess-y').messages,
    [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    'type decides, not message.role');
});

// 绝不返回空数组：那会让前端画出「已恢复历史对话，0 条消息」的假横幅。
// 宁可退回指针-only（前端照现在的提示走），不假装有历史。
test('cc restore falls back to pointers alone when the jsonl is gone', (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 目录在、但里面没有 jsonl（被手删 / 被清）
  store.save({ id: 'sess-z', adapter: 'cc', ccSessionId: 'gone', configDir: dir });
  assert.deepEqual(cc.restore('sess-z'), null, 'no transcript file at all: not restorable');
  // 有文件、但一行对话都没有
  plantTranscript(dir, 'sess-z2', [JSON.stringify({ type: 'attachment' })]);
  store.save({ id: 'sess-z2', adapter: 'cc', ccSessionId: 'sess-z2', configDir: dir });
  const r = cc.restore('sess-z2');
  assert.equal(r.messages, undefined, 'no dialogue lines: omit messages, do not return []');
  assert.equal(r.ccSessionId, 'sess-z2', '--resume still gets its pointers');
});

// ── 钉住 readCcDialogue 承诺过的四种边界行为（review 补缺，2026-10-23）──────
// 代码注释声称了这些行为却没有测试看着；守卫被删掉时对应用例要独立变红。

// 1. 截断的末行：「单行坏了只丢那一行」——一份 213 KB 的文件不该因为末尾
//    半行而整个读不出来。
test('cc restore drops a truncated trailing line but keeps the dialogue', (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const truncated = JSON.stringify(DIALOGUE_LINES[1] && {
    type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '被截断的行' }] },
  }).slice(0, 40);
  plantTranscript(dir, 'sess-trunc', [
    DIALOGUE_LINES[0],
    truncated,
    DIALOGUE_LINES[1],
  ]);
  store.save({ id: 'sess-trunc', adapter: 'cc', ccSessionId: 'sess-trunc', configDir: dir });
  const r = cc.restore('sess-trunc');
  assert.deepEqual(r.messages, [
    { role: 'user', content: [{ type: 'text', text: '写一个贪吃蛇' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '先想清楚游戏循环' },
      { type: 'text', text: '好的，我来写。' },
    ] },
  ], 'bad line dropped, both good lines kept');
});

// 2. 字符串 content：代码明确接受 typeof content === 'string'，原样透传给
//    前端的字符串渲染路径——钉住它，防止悄悄退化成只支持块数组。
test('cc restore passes string content through verbatim', (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  plantTranscript(dir, 'sess-str', [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'plain string' } }),
  ]);
  store.save({ id: 'sess-str', adapter: 'cc', ccSessionId: 'sess-str', configDir: dir });
  assert.deepEqual(cc.restore('sess-str').messages,
    [{ role: 'user', content: 'plain string' }],
    'string content goes through untouched');
});

// 3. message 不是对象 / 缺失：守卫抛异常会让 POST /sessions 的恢复路径 500。
//    这里最要紧的是「不抛」。
test('cc restore survives lines whose message is not an object or is missing', (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  plantTranscript(dir, 'sess-badmsg', [
    JSON.stringify({ type: 'user', message: 'oops' }),
    JSON.stringify({ type: 'assistant' }),
    DIALOGUE_LINES[0],
  ]);
  store.save({ id: 'sess-badmsg', adapter: 'cc', ccSessionId: 'sess-badmsg', configDir: dir });
  const r = cc.restore('sess-badmsg'); // 不抛即是过半
  assert.deepEqual(r.messages,
    [{ role: 'user', content: [{ type: 'text', text: '写一个贪吃蛇' }] }],
    'bad-message lines skipped, good line kept');
});

// 4. 空文件：文件在、零行——只回指针（messages 为 undefined），绝不回 []。
test('cc restore falls back to pointers for an empty transcript file', (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  plantTranscript(dir, 'sess-empty', []);
  store.save({ id: 'sess-empty', adapter: 'cc', ccSessionId: 'sess-empty', configDir: dir });
  const r = cc.restore('sess-empty');
  assert.equal(r.messages, undefined, 'empty file: no messages key');
  assert.equal(r.ccSessionId, 'sess-empty');
});
