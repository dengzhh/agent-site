import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { createPiAdapter } from '../src/adapters/pi.mjs';

const collect = async (iter) => { const out = []; for await (const e of iter) out.push(e); return out; };

function fauxSetup() {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  return { models, faux };
}

test('pi adapter streams deltas then turn_end', async () => {
  const { models, faux } = fauxSetup();
  faux.setResponses([fauxAssistantMessage([fauxText('hi from pi')])]);
  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
  });
  const events = await collect(pi.run({
    messages: [{ role: 'user', content: 'hi' }],
    request: { provider: 'faux', model: 'faux' },
    apiKey: null,
  }));
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'hi from pi');
  assert.ok(events.some((e) => e.type === 'turn_end'));
});

test('pi adapter surfaces provider errors as error events', async () => {
  const { models, faux } = fauxSetup();
  // faux 队列为空 → provider 报错
  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
  });
  const events = await collect(pi.run({
    messages: [{ role: 'user', content: 'hi' }],
    request: { provider: 'faux', model: 'faux' },
    apiKey: null,
  }));
  assert.ok(events.some((e) => e.type === 'error'), 'error event present');
});

test('pi adapter reports available', async () => {
  const { models } = fauxSetup();
  const pi = createPiAdapter({ models, resolve: () => ({}) });
  assert.equal(await pi.available(), true);
});

// 最小 stub Agent：run() 只依赖 subscribe/prompt/abort/state 四个接口。
// prompt 立即 resolve → settled 置位 → 事件循环排空后正常退出（不挂起）。
const stubAgent = () => ({
  subscribe: () => () => {},
  prompt: async () => {},
  abort: () => {},
  state: {},
});

test('pi adapter attaches read tools when tier is read', async () => {
  const { models, faux } = fauxSetup();
  let seenTools;
  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
    makeAgent: (_models, _model, _sessionId, _apiKey, tools) => {
      seenTools = tools;
      return stubAgent();
    },
  });
  await collect(pi.run({
    messages: [{ role: 'user', content: 'hi' }],
    request: { provider: 'faux', model: 'faux' },
    apiKey: null, toolTier: 'read', cwd: '/tmp',
  }));
  assert.ok(Array.isArray(seenTools) && seenTools.length === 3, '3 read tools passed to Agent');
  assert.ok(seenTools.every((t) => typeof t.name === 'string' && typeof t.execute === 'function'));
});

test('pi adapter passes no tools when tier is none', async () => {
  const { models, faux } = fauxSetup();
  let seenTools = 'not-called';
  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
    makeAgent: (_m, _model, _sid, _key, tools) => { seenTools = tools; return stubAgent(); },
  });
  await collect(pi.run({
    messages: [{ role: 'user', content: 'hi' }],
    request: { provider: 'faux', model: 'faux' },
    apiKey: null, toolTier: 'none',
  }));
  assert.equal(seenTools, undefined, 'no tools for chat-only');
});

test('pi adapter cache key covers cwd and tool tier', async () => {
  const { models, faux } = fauxSetup();
  const builds = [];
  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
    makeAgent: (_m, _model, _sid, _key, tools) => { builds.push(tools); return stubAgent(); },
  });
  const run = (over) => collect(pi.run({
    messages: [{ role: 'user', content: 'hi' }],
    request: { provider: 'faux', model: 'faux' },
    apiKey: null, sessionId: 's-tools',
    ...over,
  }));

  await run({ toolTier: 'read', cwd: '/tmp' });      // 首轮：构建带工具的 Agent
  assert.equal(builds.length, 1);
  assert.ok(Array.isArray(builds[0]) && builds[0].length === 3);

  await run({ toolTier: 'read', cwd: '/tmp' });      // 同 key → 复用缓存 Agent（多轮上下文）
  assert.equal(builds.length, 1);

  await run({ toolTier: 'read', cwd: '/tmp/sub' });  // cwd 变 → 重建，工具按新 cwd 全新生成
  assert.equal(builds.length, 2);
  assert.notEqual(builds[1], builds[0], 'tools rebuilt fresh per cwd');
  assert.equal(builds[1].length, 3);

  await run({ toolTier: 'none', cwd: '/tmp/sub' });  // tier 变 → 重建，回到纯对话
  assert.equal(builds.length, 3);
  assert.equal(builds[2], undefined);

  await run({ toolTier: 'read' });                   // tier=read 但无 cwd → 不给工具（无边界即不启用）
  assert.equal(builds.length, 4);
  assert.equal(builds[3], undefined);
});

test('pi adapter terminates when prompt settles with no events', async () => {
  const { models, faux } = fauxSetup();
  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
  });
  // 不该挂起：即便 provider 立刻失败也要在合理时间内结束
  const events = await Promise.race([
    collect(pi.run({ messages: [{ role: 'user', content: 'x' }], request: {}, apiKey: null })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('adapter hung')), 5000)),
  ]);
  assert.ok(Array.isArray(events));
});

// ── 期 2：full 级别 = 只读三件套 + write_file + bash，审批闸经 run ctx 注入 ─────

test('pi adapter attaches five tools when tier is full', async () => {
  const { models, faux } = fauxSetup();
  let seenTools;
  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
    makeAgent: (_m, _model, _sid, _key, tools) => { seenTools = tools; return stubAgent(); },
  });
  await collect(pi.run({
    messages: [{ role: 'user', content: 'hi' }],
    request: { provider: 'faux', model: 'faux' },
    apiKey: null, toolTier: 'full', cwd: '/tmp',
    requestApproval: async () => true,
  }));
  assert.deepEqual(
    seenTools.map((tool) => tool.name),
    ['read_file', 'list_dir', 'grep', 'write_file', 'bash'],
    'read trio plus write/bash at full tier',
  );
});

test('pi adapter gives no tools at full tier without cwd', async () => {
  const { models, faux } = fauxSetup();
  let seenTools = 'not-called';
  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
    makeAgent: (_m, _model, _sid, _key, tools) => { seenTools = tools; return stubAgent(); },
  });
  await collect(pi.run({
    messages: [{ role: 'user', content: 'hi' }],
    request: { provider: 'faux', model: 'faux' },
    apiKey: null, toolTier: 'full',
    requestApproval: async () => true,
  }));
  assert.equal(seenTools, undefined, 'no cwd means no path boundary means no tools');
});

test('pi adapter fails closed at full tier when no approval fn is provided', async () => {
  const { models, faux } = fauxSetup();
  let seenTools;
  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
    makeAgent: (_m, _model, _sid, _key, tools) => { seenTools = tools; return stubAgent(); },
  });
  await collect(pi.run({
    messages: [{ role: 'user', content: 'hi' }],
    request: { provider: 'faux', model: 'faux' },
    apiKey: null, toolTier: 'full', cwd: tmpSandbox(),
  }));
  const write = seenTools.find((tool) => tool.name === 'write_file');
  const r = await write.execute('id1', { path: 'x.txt', content: 'y' });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'denied by user', 'missing gate must deny, never write');
});

// 缓存的 Agent 跨轮持有同一批工具，而 server 注入的 requestApproval 闭包绑定「当轮」
// 的 SSE 响应。工具必须经可变引用取当轮的审批函数——否则第 2 轮的权限帧会写进
// 第 1 轮已结束的响应，审批永远无人应答。
test('full tier routes tool approvals to the latest run ctx (cached agent)', async () => {
  const { models, faux } = fauxSetup();
  const dir = tmpSandbox();
  let seenTools;
  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
    makeAgent: (_m, _model, _sid, _key, tools) => { seenTools = tools; return stubAgent(); },
  });
  const run = (over) => collect(pi.run({
    messages: [{ role: 'user', content: 'hi' }],
    request: { provider: 'faux', model: 'faux' },
    apiKey: null, sessionId: 's-full', toolTier: 'full', cwd: dir,
    ...over,
  }));
  const calls = [];
  await run({ requestApproval: async (...a) => { calls.push(['first', ...a]); return false; } });
  await run({ requestApproval: async (...a) => { calls.push(['second', ...a]); return true; } });
  assert.ok(seenTools.length === 5, 'same cached agent reused across turns');

  const write = seenTools.find((tool) => tool.name === 'write_file');
  const r = await write.execute('id1', { path: 'note.txt', content: 'hi' });
  assert.deepEqual(calls, [['second', 'write', 'write_file note.txt (2 bytes)']], 'routed to the second turn gate');
  assert.equal(r.isError, undefined);
  rmSync(dir, { recursive: true, force: true });
});

function tmpSandbox() {
  return mkdtempSync(join(tmpdir(), 'pi-full-'));
}
