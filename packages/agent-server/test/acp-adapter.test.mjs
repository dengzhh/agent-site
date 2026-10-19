import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createAcpAdapter } from '../src/adapters/acp.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-acp-agent.mjs');
const collect = async (iter) => { const out = []; for await (const e of iter) out.push(e); return out; };

test('acp adapter does not leak host Claude Code session env into the agent process', async () => {
  const saved = { ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID };
  process.env.ENABLE_TOOL_SEARCH = 'true';
  process.env.CLAUDE_CODE_SESSION_ID = 'host-sess';
  try {
    const acp = createAcpAdapter({
      agents: { fake: { name: 'Fake', cmd: process.execPath, args: [FIXTURE], isolateEnv: (d) => ({ FAKE_HOME: d, FAKE_ACP_ECHO_ENV: '1' }) } },
    });
    const events = await collect(acp.run({ agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp' }));
    const line = events.find((e) => e.type === 'delta' && e.text.startsWith('ENV:'));
    assert.ok(line, 'fixture echoed env');
    assert.match(line.text, /TS=unset/, 'ENABLE_TOOL_SEARCH stripped');
    assert.match(line.text, /SID=unset/, 'host session id stripped');
    assert.match(line.text, /HOME=\/tmp\/atbx-acp-/, 'per-agent isolation env still applied');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

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

// ── full 级别：request_permission 转发抽屉（Task 12，期 2）────────────────────
// kind 用 'edit' 而非 'write'：ACP 的 ToolKind 词表是
// read|edit|delete|move|search|execute|think|fetch|switch_mode|other——SDK 会对
// 入参做 schema 校验，非法 kind 到不了 client 的 requestPermission。
const fakeWithPerm = (...extra) => ({
  name: 'F',
  cmd: process.execPath,
  args: [FIXTURE, '--perm-req', ...extra],
  isolateEnv: (d) => ({ FAKE_HOME: d }),
});
const gate = (allow, calls = []) => (action, summary) => { calls.push({ action, summary }); return Promise.resolve(allow); };

test('acp full tier forwards edit-kind request to the approval gate and allows', async () => {
  const calls = [];
  const acp = createAcpAdapter({ agents: { fake: fakeWithPerm('Write file src/a.ts', '--perm-kind', 'edit') } });
  const events = await collect(acp.run({
    agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp', toolTier: 'full',
    requestApproval: gate(true, calls),
  }));
  assert.ok(events.some((e) => e.type === 'delta' && /allow_once/i.test(e.text)), 'drawer allow → outcome allow_once');
  assert.equal(events.at(-1).type, 'turn_end');
  assert.equal(events.at(-1).stopReason, 'end_turn');
  assert.equal(calls.length, 1, 'gate consulted exactly once');
  assert.equal(calls[0].action, 'edit');
  assert.match(calls[0].summary, /Write file src\/a\.ts/);
  assert.ok(calls[0].summary.length <= 160, 'summary capped at 160');
});

test('acp full tier drawer denial answers reject', async () => {
  const acp = createAcpAdapter({ agents: { fake: fakeWithPerm('Write file src/a.ts', '--perm-kind', 'edit') } });
  const events = await collect(acp.run({
    agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp', toolTier: 'full',
    requestApproval: gate(false),
  }));
  assert.ok(events.some((e) => e.type === 'delta' && /reject_once/i.test(e.text)), 'drawer deny → outcome reject_once');
  assert.equal(events.at(-1).type, 'turn_end');
  assert.equal(events.at(-1).stopReason, 'end_turn');
});

test('acp full tier without an approval gate fails closed (deny, no throw)', async () => {
  const acp = createAcpAdapter({ agents: { fake: fakeWithPerm('Write file src/a.ts', '--perm-kind', 'edit') } });
  const events = await collect(acp.run({ agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp', toolTier: 'full' }));
  assert.ok(events.some((e) => e.type === 'delta' && /reject_once/i.test(e.text)), 'missing gate → deny');
  assert.equal(events.at(-1).type, 'turn_end');
  assert.equal(events.at(-1).stopReason, 'end_turn');
  assert.ok(!events.some((e) => e.type === 'error'), 'fail-closed is not an error event');
});

test('acp full tier gate rejection (thrown) still answers deny', async () => {
  const acp = createAcpAdapter({ agents: { fake: fakeWithPerm('Write file src/a.ts', '--perm-kind', 'edit') } });
  const events = await collect(acp.run({
    agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp', toolTier: 'full',
    requestApproval: () => Promise.reject(new Error('drawer exploded')),
  }));
  assert.ok(events.some((e) => e.type === 'delta' && /reject_once/i.test(e.text)), 'gate throw → deny');
  assert.equal(events.at(-1).stopReason, 'end_turn');
});

test('acp read tier keeps the heuristic and never consults the gate', async () => {
  const calls = [];
  const acp = createAcpAdapter({ agents: { fake: fakeWithPerm('Read file src/a.ts') } });
  const events = await collect(acp.run({
    agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp', toolTier: 'read',
    requestApproval: gate(true, calls),
  }));
  assert.ok(events.some((e) => e.type === 'delta' && /allow_once/i.test(e.text)), 'read-only heuristic allow');
  assert.equal(calls.length, 0, 'gate must not be invoked in read tier');
});

test('acp resolves custom option ids from the request itself', async () => {
  const options = JSON.stringify([
    { optionId: 'yes_once', name: 'Sure', kind: 'allow_once' },
    { optionId: 'no_way', name: 'Nah', kind: 'reject_once' },
  ]);
  const run = (allow) => {
    const acp = createAcpAdapter({ agents: { fake: fakeWithPerm('Write file src/a.ts', '--perm-kind', 'edit', '--perm-options', options) } });
    return collect(acp.run({ agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp', toolTier: 'full', requestApproval: gate(allow) }));
  };
  const allowed = await run(true);
  assert.ok(allowed.some((e) => e.type === 'delta' && /PERM: yes_once/.test(e.text)), 'allow resolves custom allow optionId');
  const denied = await run(false);
  assert.ok(denied.some((e) => e.type === 'delta' && /PERM: no_way/.test(e.text)), 'deny resolves custom reject optionId');
});

// ── 审查修正：once 优先 + cancelled 兜底（绝不替用户「记住」）─────────────────

test('acp full tier answers the once-option even when always is offered first', async () => {
  const options = JSON.stringify([
    { optionId: 'remember', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'never-again', name: 'Always reject', kind: 'reject_always' },
    { optionId: 'deny-once', name: 'Reject', kind: 'reject_once' },
  ]);
  const acp = createAcpAdapter({ agents: { fake: fakeWithPerm('Write file src/a.ts', '--perm-kind', 'edit', '--perm-options', options) } });
  const run = (allow) => collect(acp.run({
    agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp', toolTier: 'full',
    requestApproval: gate(allow),
  }));
  const allowed = await run(true);
  assert.ok(allowed.some((e) => e.type === 'delta' && /PERM: allow-once/.test(e.text)), 'allow picks the once option');
  assert.ok(!allowed.some((e) => e.type === 'delta' && /PERM: remember/.test(e.text)), 'must never answer allow_always');
  const denied = await run(false);
  assert.ok(denied.some((e) => e.type === 'delta' && /PERM: deny-once/.test(e.text)), 'deny picks the once option');
  assert.ok(!denied.some((e) => e.type === 'delta' && /PERM: never-again/.test(e.text)), 'must never answer reject_always');
});

test('acp full tier answers cancelled when only allow_always is offered (no auto-remember)', async () => {
  const options = JSON.stringify([
    { optionId: 'remember', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
  ]);
  const acp = createAcpAdapter({ agents: { fake: fakeWithPerm('Write file src/a.ts', '--perm-kind', 'edit', '--perm-options', options) } });
  const events = await collect(acp.run({
    agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp', toolTier: 'full',
    requestApproval: gate(true),
  }));
  assert.ok(events.some((e) => e.type === 'delta' && /PERM: cancelled/.test(e.text)), 'always-only allow → cancelled outcome');
  assert.ok(!events.some((e) => e.type === 'delta' && /PERM: remember/.test(e.text)), 'must not select the always option');
  assert.equal(events.at(-1).type, 'turn_end');
  assert.equal(events.at(-1).stopReason, 'end_turn');
});

test('acp full tier answers cancelled when the request offers no options', async () => {
  const acp = createAcpAdapter({ agents: { fake: fakeWithPerm('Write file src/a.ts', '--perm-kind', 'edit', '--perm-options', '[]') } });
  const events = await collect(acp.run({
    agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp', toolTier: 'full',
    requestApproval: gate(true),
  }));
  assert.ok(events.some((e) => e.type === 'delta' && /PERM: cancelled/.test(e.text)), 'no options → cancelled outcome');
  assert.ok(!events.some((e) => e.type === 'delta' && /PERM: .*allow|remember/i.test(e.text)), 'never auto-allows without options');
  assert.equal(events.at(-1).stopReason, 'end_turn');
});

test('acp full tier never answers the allow option on a deny decision, whatever its name', async () => {
  // 旧 name 兜底：deny 决策在没有任何 reject_* kind 选项时，/no/i 会命中
  // "Notify me and proceed"——把放行项答给拒绝决策（fail-open）。
  // 新逻辑：kind 是唯一依据，缺失 → cancelled。
  const options = JSON.stringify([
    { optionId: 'notify', name: 'Notify me and proceed', kind: 'allow_once' },
  ]);
  const acp = createAcpAdapter({ agents: { fake: fakeWithPerm('Write file src/a.ts', '--perm-kind', 'edit', '--perm-options', options) } });
  const events = await collect(acp.run({
    agentId: 'fake', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp', toolTier: 'full',
    requestApproval: gate(false),
  }));
  assert.ok(events.some((e) => e.type === 'delta' && /PERM: cancelled/.test(e.text)), 'deny without a reject-kind option → cancelled');
  assert.ok(!events.some((e) => e.type === 'delta' && /PERM: notify/.test(e.text)), 'name keywords must never cross-pick the allow option');
  assert.equal(events.at(-1).stopReason, 'end_turn');
});
