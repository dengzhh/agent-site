import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCcAdapter } from '../src/adapters/cc.mjs';

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
