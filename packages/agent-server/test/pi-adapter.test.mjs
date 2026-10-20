import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { createPiAdapter } from '../src/adapters/pi.mjs';
import { withUsage } from '../src/pi-session-writer.mjs';
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
      // state.messages 是「本轮结束后 Agent 应处于的完整状态」，直接替换而不是
      // 追加：追加会把构造时已放进 state 的同批消息再叠一遍。
      if (state.messages) agent.state.messages = [...state.messages];
      if (state.errorMessage) agent.state.errorMessage = state.errorMessage;
      // stopReason 可配置：aborted/error 轮的落盘行为各有用例钉住。
      emit?.({ type: 'turn_end', message: { stopReason: state.stopReason ?? 'stop' }, toolResults: [] });
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

// faux 响应工厂：ctx.messages 就是发给 provider 的 transcript（Agent 眼中的完整上下文）。
const reply = (text, seen) => (ctx) => {
  if (seen) seen.push(ctx.messages);
  return fauxAssistantMessage([fauxText(text)]);
};

function piSetup(store, makeAgent) {
  const { models, faux } = fauxSetup();
  faux.setResponses([reply('reply one'), reply('reply two')]);
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
    // 不存 piSessionId/gatewaySessionId：与 id 同值纯属重复，且真 CLI id 归 Task 5
    assert.equal(rec.piSessionId, undefined);
    assert.equal(rec.gatewaySessionId, undefined);
    const userMsgs = rec.messages.filter((m) => m.role === 'user');
    assert.ok(userMsgs.some((m) => JSON.stringify(m).includes('first question')), 'user text persisted');
    assert.ok(rec.messages.some((m) => m.role === 'assistant'), 'assistant reply persisted');
    // cwd/provider/model/title 归网关记（Task 5），适配器绝不越权覆盖：
    assert.equal(rec.cwd, undefined, 'adapter must not write cwd');
    assert.equal(rec.provider, undefined, 'adapter must not write provider');
    assert.equal(rec.model, undefined, 'adapter must not write model');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pi adapter preserves a partial usage object when persisting', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    // 残缺 usage（无 totalTokens）本身是安全的：pi 的 calculateContextTokens
    // 只在 usage 整个缺失时才崩。零填充只补「缺」，绝不拿零覆盖真实计数。
    const { pi } = piSetup(store, () => stubAgent({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: { input: 10, output: 5 } },
      ],
    }));
    await runTurn(pi, 'q');
    const rec = store.get('sess-pi-1');
    const asst = rec.messages.find((m) => m.role === 'assistant');
    assert.ok(asst, 'assistant message persisted');
    assert.deepEqual(asst.usage, { input: 10, output: 5 }, 'real partial usage preserved unchanged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// usage 整个缺失才是致命的：pi 的 calculateContextTokens 直接读
// usage.totalTokens（实测库与真 CLI 0.84.3 都抛
// "Cannot read properties of undefined"）。落盘时补零，恢复出来的历史才可喂回。
test('pi adapter zero-fills an absent usage when persisting', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { pi } = piSetup(store, () => stubAgent({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      ],
    }));
    await runTurn(pi, 'q');
    const rec = store.get('sess-pi-1');
    const asst = rec.messages.find((m) => m.role === 'assistant');
    assert.equal(asst.usage.totalTokens, 0, 'usage present with totalTokens');
    assert.equal(asst.usage.input, 0);
    assert.equal(asst.usage.cost.total, 0);
    // user 消息本来就没有 usage，不该被塞一个
    const user = rec.messages.find((m) => m.role === 'user');
    assert.equal(user.usage, undefined, 'user messages untouched');
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

// ── 修复轮：aborted 轮不落盘、gatewaySessionId 更名、逐字段合并不被清空 ────────

// aborted 的 turn_end 不得覆盖已落盘的好记录：客户端断连会 abort()（server.mjs
// 的 SSE teardown），库对 aborted 与 error 同样发 turn_end（stopReason 区分）。
// 占位 assistant 消息混进历史，下一轮就会喂给模型——脏上下文。
test('an aborted turn does not overwrite the previously persisted record', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { pi } = piSetup(store, () => stubAgent({
      messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }],
      stopReason: 'aborted',
    }));
    store.save({ id: 'sess-pi-1', adapter: 'pi', agent: 'pi', messages: [{ role: 'user', content: 'good history' }] });
    const before = store.get('sess-pi-1');
    const events = await runTurn(pi, 'q', { signal: abortSignalNow() });
    assert.ok(events.some((e) => e.type === 'turn_end'));
    assert.deepEqual(store.get('sess-pi-1'), before, 'aborted turn must not touch the record');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an errored turn likewise leaves the prior record untouched', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { pi } = piSetup(store, () => stubAgent({
      messages: [{ role: 'assistant', content: [], stopReason: 'error' }],
      stopReason: 'error', errorMessage: 'boom',
    }));
    store.save({ id: 'sess-pi-1', adapter: 'pi', agent: 'pi', messages: [{ role: 'user', content: 'good history' }] });
    const before = store.get('sess-pi-1');
    await runTurn(pi, 'q');
    assert.deepEqual(store.get('sess-pi-1'), before, 'errored turn must not touch the record');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 逐字段合并的边界：适配器绝不写 gateway 归档的配置字段（cwd/provider/model/
// title）。若哪天把 null 或 undefined 显式传进 save，undefined 会走「保留旧值」
// 分支测不出来，null 却是显式清除——R2（记录被适配器清空）就是这么发生的。
// 本用例先由网关写入四个配置字段，再跑一轮适配器的 save，断言四者原样存活。
test('persisting a turn preserves gateway-owned fields (no R2 clobber)', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { pi } = piSetup(store, () => stubAgent({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }],
    }));
    store.save({
      id: 'sess-pi-1', adapter: 'pi', agent: 'pi',
      cwd: '/work', provider: 'openrouter', model: 'free-small', title: 'My chat',
      messages: [{ role: 'user', content: 'seed' }],
    });
    await runTurn(pi, 'next');
    const rec = store.get('sess-pi-1');
    assert.equal(rec.cwd, '/work');
    assert.equal(rec.provider, 'openrouter');
    assert.equal(rec.model, 'free-small');
    assert.equal(rec.title, 'My chat');
    // stub 的 prompt 把 state.messages 作为「本轮结束后的完整状态」整体替换，
    // 故断言本轮的 assistant 产出覆盖了种子历史且消息确实被重写。
    assert.ok(rec.messages.some((m) => JSON.stringify(m).includes('"a"')), 'messages rewritten this turn');
    assert.ok(!rec.messages.some((m) => JSON.stringify(m).includes('seed')), 'stale seed replaced');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 端到端：恢复的历史必须真的到达 provider ────────────────────────────────────
// 上面所有恢复用例都只断言 makeAgent 的第 6 个参数——把播种整段掐掉，它们
// 照样全绿（已实测）。所以这里走真实 defaultMakeAgent：第 1 轮跑完落盘 →
// 换一个新的适配器实例（同一 store）→ 第 2 轮，断言 faux provider 实际收到
// 的上下文里有第 1 轮的用户文本与助手回复。
test('a new adapter instance restores history all the way to the provider', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const boot = (replies) => {
      const seen = [];
      const { models, faux } = fauxSetup();
      faux.setResponses(replies.map((r) => reply(r, seen)));
      const pi = createPiAdapter({
        models,
        resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
        transcripts: store,
      });
      return { pi, seen };
    };
    const turn = (pi, text) => collect(pi.run({
      messages: [{ role: 'user', content: text }],
      request: { provider: 'faux', model: 'faux' },
      apiKey: 'k', sessionId: 'sess-pi-1', cwd: '/tmp', toolTier: 'none',
    }));

    const first = boot(['reply one']);
    await turn(first.pi, 'first question');
    assert.ok(store.get('sess-pi-1'), 'turn one persisted');

    const second = boot(['reply two']);
    const events = await turn(second.pi, 'second question');
    assert.ok(events.some((e) => e.type === 'turn_end'), 'turn two ended');
    assert.equal(second.seen.length, 1, 'second turn made exactly one provider call');
    const ctx = JSON.stringify(second.seen[0]);
    assert.ok(ctx.includes('first question'), 'provider saw turn one user text');
    assert.ok(ctx.includes('reply one'), 'provider saw turn one assistant reply');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 落盘失败不得毁掉本轮：库会 await 订阅者，这里抛出去会变成第二个
// turn_end{stopReason:'error'} 并写上 state.errorMessage，run 末尾的错误清理
// 随即把缓存里的 Agent 逐出——磁盘满一次，整个会话的对话就没了。
// 判据用真实 Agent：逐出会让第 2 轮拿到空白上下文（历史重置）。
test('a failing transcript save does not corrupt or evict the turn', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save = () => { throw new Error('ENOSPC: disk full'); };
    const seen = [];
    const { models, faux } = fauxSetup();
    faux.setResponses([reply('reply one', seen), reply('reply two', seen)]);
    const pi = createPiAdapter({
      models,
      resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
      transcripts: store,
    });
    const turn = (text) => collect(pi.run({
      messages: [{ role: 'user', content: text }],
      request: { provider: 'faux', model: 'faux' },
      apiKey: 'k', sessionId: 'sess-pi-1', cwd: '/tmp', toolTier: 'none',
    }));

    const events = await turn('first question');
    assert.equal(events.filter((e) => e.type === 'turn_end').length, 1, 'exactly one turn_end');
    assert.equal(events.find((e) => e.type === 'turn_end').stopReason, 'stop', 'still a success');
    assert.ok(!events.some((e) => e.type === 'error'), 'no error event surfaced to the client');

    await turn('second question');
    assert.equal(seen.length, 2);
    assert.ok(JSON.stringify(seen[1]).includes('first question'),
      'cached Agent survived (no eviction) — its in-memory history is intact');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// cache=false 的一次性 Agent（failover）只见到本轮——它的单轮 transcript
// 若写进共享记录，等于用一turn历史覆盖掉真会话。
test('a cache:false run does not write the shared record', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save({ id: 'sess-pi-1', adapter: 'pi', agent: 'pi', messages: [{ role: 'user', content: 'real history' }] });
    const before = store.get('sess-pi-1');
    const { pi } = piSetup(store, () => stubAgent({
      messages: [{ role: 'user', content: 'throwaway' }, { role: 'assistant', content: [{ type: 'text', text: 'x' }] }],
    }));
    await runTurn(pi, 'throwaway', { cache: false });
    assert.deepEqual(store.get('sess-pi-1'), before, 'throwaway run must not touch the record');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// withUsage 的单元口径（Task 5 的镜像写盘共用同一个 helper）
test('withUsage zero-fills only absent usage', async () => {
  const partial = { input: 10, output: 5 };
  const out = withUsage([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [], usage: partial },
    { role: 'assistant', content: [] },
  ]);
  assert.equal(out[0].usage, undefined, 'user message untouched');
  assert.equal(out[1].usage, partial, 'partial usage preserved by reference');
  assert.deepEqual(Object.keys(out[2].usage).sort(),
    ['cacheRead', 'cacheWrite', 'cost', 'input', 'output', 'totalTokens']);
  assert.equal(out[2].usage.totalTokens, 0);
});

function abortSignalNow() {
  const c = new AbortController();
  c.abort();
  return c.signal;
}

// LRU 逐出后再发言：真实世界的双重播种风险。会话被挤出一 capacity 的缓存后，
// Agent 重建、种子回灌——此时种下的历史必须恰好等于记录里的条数，不能翻倍。
test('LRU eviction then a new turn seeds exactly the persisted history once', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const seen = [];
    const { models, faux } = fauxSetup();
    // 记录里预放 3 条历史；stub 每轮再各产出 1 条 user + 1 条 assistant
    store.save({
      id: 'sess-pi-1', adapter: 'pi', agent: 'pi',
      messages: [
        { role: 'user', content: 'h1' },
        { role: 'assistant', content: [{ type: 'text', text: 'h1r' }] },
        { role: 'user', content: 'h2' },
      ],
    });
    const pi = createPiAdapter({
      models,
      resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
      transcripts: store,
      capacity: 1, // 极小缓存：第二个会话一进来就把 sess-pi-1 挤出去
      makeAgent: (_m, _model, sid, _key, _tools, restored) => {
        seen.push({ sid, restored });
        return stubAgent({
          messages: [
            { role: 'user', content: 't1' },
            { role: 'assistant', content: [{ type: 'text', text: 't1r' }] },
          ],
        });
      },
    });
    const opts = { request: { provider: 'faux', model: 'faux' }, apiKey: 'k', toolTier: 'none' };
    // 第 1 轮：冷启动播种（seen[0] = 3 条历史）
    await collect(pi.run({ messages: [{ role: 'user', content: 'first' }], sessionId: 'sess-pi-1', ...opts }));
    assert.equal(seen[0].sid, 'sess-pi-1');
    assert.equal(seen[0].restored.length, 3, 'first cold start seeds the 3 persisted messages');
    // 挤出：另一个会话占据 capacity=1 的唯一槽位
    await collect(pi.run({ messages: [{ role: 'user', content: 'other' }], sessionId: 'sess-other', ...opts }));
    assert.equal(seen[1].sid, 'sess-other', 'second session builds its own agent (evicts sess-pi-1)');
    // 第 3 轮：sess-pi-1 的 Agent 已被逐出 → 重建 + 重新播种。历史 = 3（预置）
    // + 第 1 轮落盘的 2 条 = 5 条；种子必须正好 5 条，不能 3+5 翻倍。
    await collect(pi.run({ messages: [{ role: 'user', content: 'third' }], sessionId: 'sess-pi-1', ...opts }));
    assert.equal(seen[2].sid, 'sess-pi-1', 'evicted session rebuilds an agent');
    const rec = store.get('sess-pi-1');
    assert.equal(seen[2].restored.length, rec.messages.length, 'seeded count equals history length exactly');
    assert.equal(seen[2].restored.filter((m) => JSON.stringify(m).includes('t1r')).length, 1, 'no duplication of the prior turn');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
