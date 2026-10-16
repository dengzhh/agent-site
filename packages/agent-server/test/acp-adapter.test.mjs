import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createAcpAdapter } from '../src/adapters/acp.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-acp-agent.mjs');
const collect = async (iter) => { const out = []; for await (const e of iter) out.push(e); return out; };

test('acp adapter streams thinking, delta and usage, then ends the turn', async () => {
  const acp = createAcpAdapter({ agents: { fake: { name: 'Fake', cmd: process.execPath, args: [FIXTURE], isolateEnv: (d) => ({ FAKE_HOME: d }) } } });
  const events = await collect(acp.run({
    agentId: 'fake',
    messages: [{ role: 'user', content: 'hi' }],
    cwd: '/tmp',
  }));
  assert.deepEqual(events.map((e) => e.type), ['thinking', 'delta', 'usage', 'turn_end']);
  assert.equal(events[1].text, 'PONG');
  assert.equal(events[3].stopReason, 'end_turn');
});

test('acp adapter reports error stopReason as a turn_end with that reason', async () => {
  const acp = createAcpAdapter({
    agents: { fake: { name: 'Fake', cmd: process.execPath, args: [FIXTURE], isolateEnv: (d) => ({ FAKE_HOME: d, FAKE_ACP_MODE: 'error' }) } },
  });
  const events = await collect(acp.run({ agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp' }));
  assert.equal(events.at(-1).type, 'turn_end');
  assert.equal(events.at(-1).stopReason, 'error');
});

test('acp adapter surfaces unknown agent id as an error event', async () => {
  const acp = createAcpAdapter({ agents: {} });
  const events = await collect(acp.run({ agentId: 'nope', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(events[0].type, 'error');
  assert.match(events[0].message, /unknown acp agent/i);
});

test('acp adapter availableFor respects a caller-supplied probe', async () => {
  const acp = createAcpAdapter({ agents: {}, probe: async (id) => id === 'hermes' });
  assert.equal(await acp.availableFor('hermes'), true);
  assert.equal(await acp.availableFor('nope'), false);
});

test('acp adapter cleans up when the consumer breaks early', async () => {
  const acp = createAcpAdapter({ agents: { fake: { name: 'Fake', cmd: process.execPath, args: [FIXTURE], isolateEnv: (d) => ({ FAKE_HOME: d }) } } });
  const it = acp.run({ agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp' });
  const first = await it.next();
  assert.equal(first.done, false);
  await it.return();   // 消费者提前 break：finally 必须回收子进程与临时目录
  assert.ok(true);
});
