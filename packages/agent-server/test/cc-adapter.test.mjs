import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCcAdapter } from '../src/adapters/cc.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude.sh');
const FLOOD_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude-stderr-flood.sh');
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
