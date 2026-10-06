import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCcAdapter } from '../src/adapters/cc.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude.sh');
const collect = async (iter) => { const out = []; for await (const e of iter) out.push(e); return out; };

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
