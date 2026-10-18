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

// --perm-req 模式：fixture 以真正的 JSON-RPC 请求发出 session/request_permission，
// 驱动真实客户端实现的 requestPermission 应答逻辑（tier 启发式，期 1）。
test('acp requestPermission allows read-only tools in read tier', async () => {
  const acp = createAcpAdapter({
    agents: { fake: { name: 'F', cmd: process.execPath, args: [FIXTURE, '--perm-req', 'Read file src/a.ts'], isolateEnv: (d) => ({ FAKE_HOME: d }) } },
  });
  const events = await collect(acp.run({ agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp', toolTier: 'read' }));
  assert.ok(events.some((e) => e.type === 'delta' && /allow/i.test(e.text)), 'perm answered allow');
});

test('acp requestPermission denies write tools in read tier', async () => {
  const acp = createAcpAdapter({
    agents: { fake: { name: 'F', cmd: process.execPath, args: [FIXTURE, '--perm-req', 'Write file src/a.ts'], isolateEnv: (d) => ({ FAKE_HOME: d }) } },
  });
  const events = await collect(acp.run({ agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp', toolTier: 'read' }));
  // 拒绝路径的 optionId 是 ACP 标准的 reject_once（fixture 回显原样），故匹配 reject 而非 deny。
  assert.ok(events.some((e) => e.type === 'delta' && /deny|reject/i.test(e.text)), 'perm answered deny');
});

test('acp tier none denies everything', async () => {
  const acp = createAcpAdapter({
    agents: { fake: { name: 'F', cmd: process.execPath, args: [FIXTURE, '--perm-req', 'Read file src/a.ts'], isolateEnv: (d) => ({ FAKE_HOME: d }) } },
  });
  const events = await collect(acp.run({ agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp', toolTier: 'none' }));
  assert.ok(events.some((e) => e.type === 'delta' && /deny|reject/i.test(e.text)), 'tier none denies');
});
