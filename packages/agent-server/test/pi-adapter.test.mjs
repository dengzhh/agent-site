import { test } from 'node:test';
import assert from 'node:assert/strict';
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
