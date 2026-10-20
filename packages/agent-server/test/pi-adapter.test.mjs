import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { createPiAdapter } from '../src/adapters/pi.mjs';
import { TranscriptStore } from '../src/transcripts.mjs';

const collect = async (iter) => { const out = []; for await (const e of iter) out.push(e); return out; };
const freshDir = () => mkdtempSync(join(tmpdir(), 'pi-tr-'));

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
// 会发 turn_end 的 stub：落盘挂在 turn_end 订阅上，没有它适配器不会写 store。
// 不传 state 时与旧的静默 stub 等价（不发事件、prompt 立即 resolve）。
const stubAgent = (state = {}) => {
  let emit = null;
  const agent = {
    subscribe: (fn) => { emit = fn; return () => { emit = null; }; },
    prompt: async () => {
      if (state.messages) agent.state.messages = [...agent.state.messages, ...state.messages];
      if (state.errorMessage) agent.state.errorMessage = state.errorMessage;
      emit?.({ type: 'turn_end', message: { stopReason: 'stop' }, toolResults: [] });
    },
    abort: () => {},
    state: { messages: [], ...state },
  };
  return agent;
};

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

// ── Task 4：跨进程持久化（transcripts store）与恢复 ──────────────────────────────

// faux 响应工厂：拿到发给 provider 的 transcript（即 Agent 眼中的完整上下文）。
const capture = (reply) => (ctx) => { capture.seen = ctx.messages; return fauxAssistantMessage([fauxText(reply)]); };
capture.seen = [];

function piSetup(store, makeAgent) {
  const { models, faux } = fauxSetup();
  faux.setResponses([capture('reply one'), capture('reply two')]);
  const opts = {
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
    ...(store ? { transcripts: store } : {}),
    ...(makeAgent ? { makeAgent } : {}),
  };
  return { pi: createPiAdapter(opts), faux };
}

const runTurn = (pi, text, over = {}) => collect(pi.run({
  messages: [{ role: 'user', content: text }],
  request: { provider: 'faux', model: 'faux' },
  apiKey: 'k', sessionId: 'sess-pi-1', cwd: '/tmp', toolTier: 'none',
  ...over,
}));

test('pi adapter persists the conversation on turn_end', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { pi } = piSetup(store);
    const events = await runTurn(pi, 'first question');
    assert.ok(events.some((e) => e.type === 'turn_end'), 'turn ended');
    const rec = store.get('sess-pi-1');
    assert.ok(rec, 'record saved');
    assert.equal(rec.adapter, 'pi');
    assert.equal(rec.agent, 'pi');
    assert.equal(rec.piSessionId, 'sess-pi-1', 'piSessionId recorded for Task 5 mirroring');
    const userMsgs = rec.messages.filter((m) => m.role === 'user');
    assert.ok(userMsgs.some((m) => JSON.stringify(m).includes('first question')), 'user text persisted');
    assert.ok(rec.messages.some((m) => m.role === 'assistant'), 'assistant reply persisted');
    // cwd/provider/model/title 归网关记（Task 5），适配器绝不越权覆盖：
    assert.equal(rec.cwd, undefined, 'adapter must not write cwd');
    assert.equal(rec.provider, undefined, 'adapter must not write provider');
    assert.equal(rec.model, undefined, 'adapter must not write model');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pi adapter does not persist a partial usage object', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    // Agent 落在 transcript 里的 assistant 消息带残缺 usage（无 totalTokens）时，
    // 持久化必须剥掉 usage：pi CLI resume 读到 usage.totalTokens 会崩
    // （"Cannot read properties of undefined (reading 'totalTokens')"）。
    const { pi } = piSetup(store, () => stubAgent({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: { input: 1, output: 2 } },
      ],
    }));
    await runTurn(pi, 'q');
    const rec = store.get('sess-pi-1');
    const asst = rec.messages.find((m) => m.role === 'assistant');
    assert.ok(asst, 'assistant message persisted');
    assert.equal(asst.usage, undefined, 'partial usage stripped before persist');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pi adapter keeps a complete usage object when persisting', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const usage = { input: 1, output: 2, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const { pi } = piSetup(store, () => stubAgent({
      messages: [{ role: 'assistant', content: [], usage }],
    }));
    await runTurn(pi, 'q');
    const rec = store.get('sess-pi-1');
    assert.deepEqual(rec.messages[0].usage, usage, 'complete usage survives');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restore returns messages for a persisted session', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { pi } = piSetup(store);
    await runTurn(pi, 'first question');
    const r = pi.restore('sess-pi-1');
    assert.ok(r && Array.isArray(r.messages) && r.messages.length > 0, 'restore yields messages');
    assert.ok(JSON.stringify(r.messages).includes('first question'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restore returns null when there is nothing honest to restore', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { pi } = piSetup(store);
    // 无记录
    assert.equal(pi.restore('sess-nothing'), null);
    // 有记录但 messages 为空：谎称可恢复会让上层把空上下文当历史
    store.save({ id: 'sess-empty', adapter: 'pi', agent: 'pi', messages: [] });
    assert.equal(pi.restore('sess-empty'), null);
    // 记录属于别的适配器
    store.save({ id: 'sess-cc', adapter: 'cc', agent: 'cc', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(pi.restore('sess-cc'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 冷启动恢复：缓存未命中（新适配器实例 ≈ 网关重启）时，Agent 的初始上下文
// 必须带上上一轮的用户消息与回复——pi-agent-core 唯一的恢复入口是
// initialState.messages。已存活的缓存绝不重新播种（否则历史会翻倍）。
test('pi adapter seeds initialState.messages on a cold cache miss only', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const seen = [];
    const built = [];
    const makeAgent = (_m, _model, _sid, _key, _tools, restored) => {
      seen.push(restored ?? null);
      const a = stubAgent();
      built.push(a);
      return a;
    };
    const { pi } = piSetup(store, makeAgent);
    await runTurn(pi, 'first question');
    assert.equal(seen.length, 1, 'cold start builds a fresh agent');
    assert.equal(seen[0], null, 'first turn seeds nothing (no history yet)');

    // 同一适配器、缓存命中：不重建、也绝不重播历史。stub 不写盘，先手动放一份
    // 记录进去模拟「上一进程留下的历史」——若恢复逻辑错把种子喂给存活的缓存
    // Agent，同一份历史就会在下一轮出现两次。
    store.save({
      id: 'sess-pi-1', adapter: 'pi', agent: 'pi',
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: [{ type: 'text', text: 'reply one' }] },
      ],
    });
    await runTurn(pi, 'second question');
    assert.equal(seen.length, 1, 'warm cache reuses the agent, makeAgent not called');
    assert.equal(seen[0], null);
    assert.deepEqual(built[0].state.messages, [], 'warm cached agent untouched by restore (no duplication)');

    // 新适配器实例 + 同一 store：冷启动 → 播种持久化的历史。
    // （stub Agent 不累积 state，历史直接预先写进 store 模拟上一进程留下的记录。）
    store.save({
      id: 'sess-pi-1', adapter: 'pi', agent: 'pi',
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: [{ type: 'text', text: 'reply one' }] },
      ],
    });
    const { pi: pi2 } = piSetup(store, makeAgent);
    await runTurn(pi2, 'second question');
    assert.equal(seen.length, 2, 'second adapter builds its own agent');
    assert.ok(Array.isArray(seen[1]) && seen[1].length > 0, 'cold start seeds restored messages');
    assert.ok(JSON.stringify(seen[1]).includes('first question'), 'seed carries prior turn');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('disposeSession must not delete the persisted record', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { pi } = piSetup(store);
    await runTurn(pi, 'first question');
    pi.disposeSession('sess-pi-1');
    // LRU 逐出会走 disposeSession（sessions.mjs 的 record.dispose）——历史必须留下，
    // 否则「重启后恢复」在逐出场景下就成了空话。
    assert.ok(store.get('sess-pi-1'), 'record survives dispose');
    assert.ok(pi.restore('sess-pi-1'), 'still restorable after dispose');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('everything keeps working without a transcripts store', async (t) => {
  const { pi } = piSetup(null);
  const events = await runTurn(pi, 'no store');
  assert.ok(events.some((e) => e.type === 'turn_end'));
  assert.equal(typeof pi.restore, 'function');
  pi.disposeSession('sess-pi-1'); // no-store 下也必须是安全的 no-op
});
