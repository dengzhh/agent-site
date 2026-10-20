// 网站开的 pi 会话必须落到本机 pi CLI 能找到的地方（共享目录，CLI 原生格式）。
//
// 四条实测约束（pi CLI 0.84.3 + 读 CLI 源码，2026-10-21）钉在这些用例里：
//   1. 布局是**平铺**的：SessionManager.list(cwd, sessionDir) 用
//      `sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)`，
//      而 listSessionsFromDir 非递归（readdir + filter .jsonl）——显式给了
//      --session-dir 时文件必须平铺在那一层，放进 <cwdSlug>/ 子目录会
//      "No session found matching"。
//   2. piSessionId 必须另外铸造：网关 sessionId 只被转发给 provider
//      （agent.js:308），与 CLI 的会话 id 无关。
//   3. 文件名固定（不含时间戳）→ 每轮覆写同一个文件，目录里不会堆 N 份副本。
//   4. assistant 的 usage 缺失会让 CLI 崩在 usage.totalTokens 上——补零，不是剥掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { createPiAdapter } from '../src/adapters/pi.mjs';
import { TranscriptStore } from '../src/transcripts.mjs';

const collect = async (iter) => { const out = []; for await (const e of iter) out.push(e); return out; };

function fauxSetup() {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  return { models, faux };
}

// 最小 stub Agent（抄自 pi-adapter.test.mjs，那个 helper 是文件局部的，不跨文件 import）。
// 会发 turn_end（stopReason 默认 'stop'）——落盘与镜像都挂在 turn_end 上。
const stubAgent = (state = {}) => {
  let emit = null;
  const agent = {
    subscribe: (fn) => { emit = fn; return () => { emit = null; }; },
    prompt: async () => {
      if (state.messages) agent.state.messages = [...state.messages];
      if (state.errorMessage) agent.state.errorMessage = state.errorMessage;
      emit?.({ type: 'turn_end', message: { stopReason: state.stopReason ?? 'stop' }, toolResults: [] });
    },
    abort: () => {},
    state: { messages: [], ...state },
  };
  return agent;
};

const readLines = (dir) => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  return {
    files,
    lines: files.length
      ? readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      : [],
  };
};

test('pi adapter mirrors the session into the shared dir in CLI-native format', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'atbx-store-'));
  const sharedDir = mkdtempSync(join(tmpdir(), 'atbx-shared-'));
  try {
    const { models, faux } = fauxSetup();
    faux.setResponses([fauxAssistantMessage([fauxText('记住了')])]);
    const store = new TranscriptStore({ dir: storeDir });
    const pi = createPiAdapter({
      models,
      resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
      transcripts: store,
      piSessionDir: sharedDir,
    });
    await collect(pi.run({
      messages: [{ role: 'user', content: '记住暗号是菠萝' }],
      request: { provider: 'faux', model: 'faux' }, apiKey: 'k',
      sessionId: 'sess-mirror-1', cwd: '/tmp/work', toolTier: 'none',
    }));

    // 平铺在 sharedDir 根下：显式 --session-dir 时 CLI 只扫描这一层
    const { files, lines } = readLines(sharedDir);
    assert.equal(files.length, 1, 'one CLI-native session file written, flat in the shared dir');
    assert.equal(lines[0].type, 'session');
    assert.equal(lines[0].cwd, '/tmp/work', 'cwd preserved for the CLI project check');
    // 0600：里面是 full tier 的工具输出，和 transcript 一个口径
    assert.equal(statSync(join(sharedDir, files[0])).mode & 0o777, 0o600, 'mirror file is owner-only');
    assert.ok(lines.some((l) => l.type === 'message' && JSON.stringify(l.message).includes('菠萝')),
      'user text present');

    const rec = store.get('sess-mirror-1');
    assert.ok(rec.piSessionId, 'piSessionId recorded so the UI can show the resume command');
    assert.equal(lines[0].id, rec.piSessionId, 'CLI file id matches the recorded one');
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(sharedDir, { recursive: true, force: true });
  }
});

// 缺失 usage 会让真 CLI 崩（Cannot read properties of undefined (reading 'totalTokens')），
// 所以镜像里的 assistant 消息 usage 必须是「补零」而不是「剥掉」。
test('mirrored assistant messages always carry a totalTokens-bearing usage', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'atbx-store-'));
  const sharedDir = mkdtempSync(join(tmpdir(), 'atbx-shared-'));
  try {
    const { models, faux } = fauxSetup();
    const store = new TranscriptStore({ dir: storeDir });
    const pi = createPiAdapter({
      models,
      resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
      transcripts: store,
      piSessionDir: sharedDir,
      // 造一条「没有 usage」的 assistant 消息：库在这种形状下不会自己补
      makeAgent: () => stubAgent({ messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: 'a' }], timestamp: 2 },  // 无 usage
      ] }),
    });
    await collect(pi.run({
      messages: [{ role: 'user', content: 'q' }],
      request: { provider: 'faux', model: 'faux' }, apiKey: 'k',
      sessionId: 'sess-usage', cwd: '/tmp/work', toolTier: 'none',
    }));
    const { files, lines } = readLines(sharedDir);
    assert.equal(files.length, 1, 'mirror written');
    const assistants = lines.filter((x) => x.type === 'message' && x.message.role === 'assistant');
    assert.ok(assistants.length > 0, 'at least one assistant message mirrored');
    for (const l of assistants) {
      assert.ok(l.message.usage, 'assistant usage present (absence crashes the CLI)');
      assert.equal(typeof l.message.usage.totalTokens, 'number', 'totalTokens always present');
    }
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(sharedDir, { recursive: true, force: true });
  }
});

// 每轮换一个新戳会在目录里堆 N 份同一会话的副本（mtime 最新的胜出，不丢内容但很脏）
test('the mirror file is rewritten in place, not recreated per turn', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'atbx-store-'));
  const sharedDir = mkdtempSync(join(tmpdir(), 'atbx-shared-'));
  try {
    const { models, faux } = fauxSetup();
    faux.setResponses([
      fauxAssistantMessage([fauxText('a')]),
      fauxAssistantMessage([fauxText('b')]),
      fauxAssistantMessage([fauxText('c')]),
    ]);
    const store = new TranscriptStore({ dir: storeDir });
    const pi = createPiAdapter({
      models,
      resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
      transcripts: store,
      piSessionDir: sharedDir,
    });
    const runOnce = () => collect(pi.run({
      messages: [{ role: 'user', content: 'hi' }],
      request: { provider: 'faux', model: 'faux' }, apiKey: 'k',
      sessionId: 'sess-stamp', cwd: '/tmp/work', toolTier: 'none',
    }));
    await runOnce(); await runOnce(); await runOnce();
    const files = readdirSync(sharedDir).filter((f) => f.endsWith('.jsonl'));
    assert.equal(files.length, 1, 'one file per session, not one per turn');
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(sharedDir, { recursive: true, force: true });
  }
});

test('mirror write failure never breaks the turn', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'atbx-store-'));
  const badDir = join(mkdtempSync(join(tmpdir(), 'atbx-bad-')), 'not-a-dir');
  try {
    const { models, faux } = fauxSetup();
    faux.setResponses([fauxAssistantMessage([fauxText('hi')])]);
    const store = new TranscriptStore({ dir: storeDir });
    // 指向一个写不进去的路径：写共享目录失败不能影响聊天本身。
    // 造法：先建一个普通文件，再把「共享目录」指向它——mkdir 会 EEXIST，
    // 在 /proc 下那种路径会挂住（实测），用临时目录里的文件更快更确定。
    writeFileSync(badDir, 'x');
    const pi = createPiAdapter({
      models,
      resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
      transcripts: store,
      piSessionDir: badDir,
    });
    const events = await collect(pi.run({
      messages: [{ role: 'user', content: 'hi' }],
      request: { provider: 'faux', model: 'faux' }, apiKey: 'k',
      sessionId: 'sess-mirror-2', cwd: '/tmp', toolTier: 'none',
    }));
    assert.ok(events.some((e) => e.type === 'turn_end'), 'turn still completes');
    assert.ok(!events.some((e) => e.type === 'error'), 'no error event leaked from the mirror');
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(dirname(badDir), { recursive: true, force: true });
  }
});

// 镜像文件本身必须是「可 resume 的形状」：session 行的 id 是那个铸造出来的
// piSessionId（--session <id> 靠它匹配），cwd 是本轮的 cwd（CLI 靠它判 project）。
test('the mirror file is resumable-shaped: session line carries piSessionId and cwd', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'atbx-store-'));
  const sharedDir = mkdtempSync(join(tmpdir(), 'atbx-shared-'));
  try {
    const { models, faux } = fauxSetup();
    faux.setResponses([fauxAssistantMessage([fauxText('ok')])]);
    const store = new TranscriptStore({ dir: storeDir });
    const pi = createPiAdapter({
      models,
      resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
      transcripts: store,
      piSessionDir: sharedDir,
    });
    await collect(pi.run({
      messages: [{ role: 'user', content: 'hi' }],
      request: { provider: 'faux', model: 'faux' }, apiKey: 'k',
      sessionId: 'sess-resumable', cwd: '/tmp/proj', toolTier: 'none',
    }));
    const rec = store.get('sess-resumable');
    const { files, lines } = readLines(sharedDir);
    assert.equal(files.length, 1);
    // 平铺：文件名就是 <piSessionId>.jsonl，CLI 非递归扫描这一层
    assert.equal(files[0], `${rec.piSessionId}.jsonl`, 'flat file named after the pi session id');
    const sessionLine = lines.find((l) => l.type === 'session');
    assert.ok(sessionLine, 'a session line exists');
    assert.equal(sessionLine.id, rec.piSessionId, 'session line id === rec.piSessionId');
    assert.equal(sessionLine.cwd, '/tmp/proj', 'session line cwd === the turn cwd');
    // parentId 链要连得上：每条 message 指向上一条
    const messages = lines.filter((l) => l.type === 'message');
    assert.ok(messages.length > 0);
    assert.equal(messages[0].parentId, lines[1].id, 'first message chains off session_info');
    for (let i = 1; i < messages.length; i++) {
      assert.equal(messages[i].parentId, messages[i - 1].id, 'message chain is contiguous');
    }
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(sharedDir, { recursive: true, force: true });
  }
});
