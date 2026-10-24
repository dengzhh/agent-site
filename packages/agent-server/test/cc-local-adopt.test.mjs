// 本地 CLI 会话的导入（硬链接）。核心不变量是**单一真源**：
// 网关视图与用户 ~/.claude 下那份是同一个 inode，所以 CLI append 写入时两边
// 天然同步，不存在「两份各自分叉的历史」。
//
// ⚠️ 本文件所有夹具都是 mkdtempSync 造的合成目录，按精确路径删除；绝不读任何
// 真实 transcript（PII 边界），也绝不用 ~/.claude 当 localRoot。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  appendFileSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCcAdapter } from '../src/adapters/cc.mjs';
import { TranscriptStore } from '../src/transcripts.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const collect = async (iter) => { const out = []; for await (const e of iter) out.push(e); return out; };
const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 起假上游（与 e2e-restore.test.mjs 同一夹具）：读端口文件，不改夹具本身。
async function startFakeAnthropic(t) {
  const portFile = join(tmpdir(), `atbx-adopt-port-${process.pid}-${Date.now()}.port`);
  const logFile = `${portFile}.log`;
  const child = spawn(process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-anthropic.mjs')],
    { env: { ...process.env, FAKE_ANTHROPIC_PORT_FILE: portFile, FAKE_ANTHROPIC_LOG: logFile }, stdio: 'ignore', detached: true });
  t.after(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    rmSync(portFile, { force: true });
    rmSync(logFile, { force: true });
  });
  let port = null;
  for (let i = 0; i < 60 && !port; i++) {
    try { const p = Number(readFileSync(portFile, 'utf8').trim()); if (p) port = p; } catch { /* 还没写 */ }
    await delay(100);
  }
  assert.ok(port, 'fake upstream started');
  return { baseUrl: `http://127.0.0.1:${port}` };
}

// 一行 CLI 会写下的 jsonl。字段形状照真实行（sessionId/uuid/parentUuid/cwd/
// gitBranch/userType/version/isSidechain/timestamp）——**缺字段 CLI 会认为
// 这不是有效会话**，导入成功也 resume 不出来。值全是假的，无真实内容。
function ccLine(type, text, sid, uuid) {
  return JSON.stringify({
    type,
    sessionId: sid,
    uuid,
    parentUuid: null,
    timestamp: new Date().toISOString(),
    cwd: '/tmp',
    gitBranch: 'main',
    userType: 'external',
    version: '2.0.14',
    isSidechain: false,
    message: {
      role: type,
      id: `msg_${uuid.slice(0, 8)}`,
      type: 'message',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text, citations: null }],
      stop_reason: type === 'user' ? null : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
}

// 造一个假「本地 ~/.claude」：projects/<slug(cwd)>/<uuid>.jsonl。
// 返回 root 与落盘的那个 cc session id。行内容纯合成。
function fakeLocalHome(t, { cwd, texts = ['第一句：本地 CLI 聊的'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'atbx-localcc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sid = randomUUID();
  const slug = String(cwd).replace(/[/.]/g, '-');
  const dir = join(root, 'projects', slug);
  mkdirSync(dir, { recursive: true });
  const lines = texts.map((text, i) => ccLine(i % 2 ? 'assistant' : 'user', text, sid, randomUUID()));
  writeFileSync(join(dir, `${sid}.jsonl`), `${lines.join('\n')}\n`);
  return { root, sid, slug, dir };
}

function makeStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'atbx-adopt-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new TranscriptStore({ dir });
}

test('adopt 把本地会话接进来：记录落盘、restore 拿得到 ccSessionId 与对话', async (t) => {
  const cwd = tmpdir();
  const { root, sid, slug } = fakeLocalHome(t, { cwd });
  const store = makeStore(t);
  const cc = createCcAdapter({ transcripts: store });

  const found = cc.localSessions(cwd, root);
  assert.equal(found.length, 1);
  assert.equal(found[0].ccSessionId, sid);
  assert.match(found[0].ccSessionId, UUID);

  const gwId = cc.adoptLocalSession({ cwd, ccSessionId: sid, gatewaySessionId: randomUUID(), localRoot: root });
  assert.ok(gwId, 'adopt returned an id');

  const rec = store.get(gwId);
  assert.equal(rec.adapter, 'cc');
  assert.equal(rec.ccSessionId, sid);
  assert.equal(rec.cwd, cwd);
  assert.equal(rec.configDir, store.companionDir(gwId));

  // restore 必须能命中：这是「前端拿到 resumed:true + 历史消息」的那一步。
  const material = cc.restore(gwId);
  assert.ok(material, 'restore returned material');
  assert.equal(material.ccSessionId, sid);
  assert.ok(Array.isArray(material.messages) && material.messages.length >= 1);
  assert.ok(material.messages.some((m) => m.role === 'user'));

  // slug 目录真的建在了私有 config dir 下（不是靠全局 home 蒙上的）
  assert.ok(existsSync(join(rec.configDir, 'projects', slug, `${sid}.jsonl`)));
});

test('导入后是硬链接，不是复制（同一 inode）——单一真源', async (t) => {
  const cwd = tmpdir();
  const { root, sid, dir } = fakeLocalHome(t, { cwd });
  const store = makeStore(t);
  const cc = createCcAdapter({ transcripts: store });

  const gwId = cc.adoptLocalSession({ cwd, ccSessionId: sid, gatewaySessionId: randomUUID(), localRoot: root });
  const local = join(dir, `${sid}.jsonl`);
  const copy = join(store.companionDir(gwId), 'projects', String(cwd).replace(/[/.]/g, '-'), `${sid}.jsonl`);

  assert.equal(statSync(local).ino, statSync(copy).ino, 'same inode => hardlink, not a copy');
  assert.equal(statSync(local).nlink, 2, '本地原件现在有两个名字');
});

test('本地原件 append 后，网关视图立刻看得到（双向同步的下半程）', async (t) => {
  const cwd = tmpdir();
  const { root, sid } = fakeLocalHome(t, { cwd });
  const store = makeStore(t);
  const cc = createCcAdapter({ transcripts: store });
  const gwId = cc.adoptLocalSession({ cwd, ccSessionId: sid, gatewaySessionId: randomUUID(), localRoot: root });

  const before = cc.restore(gwId).messages.length;
  // 模拟 CLI 又聊了一轮：往**本地那份**追加。复制方案在这里立刻露馅。
  appendFileSync(join(root, 'projects', String(cwd).replace(/[/.]/g, '-'), `${sid}.jsonl`),
    `${ccLine('assistant', '本地终端刚说的这句', sid, randomUUID())}\n`);

  const after = cc.restore(gwId).messages;
  assert.equal(after.length, before + 1);
  // readCcDialogue 原样带出 CLI 的块数组 content，不做扁平化——两种形状都认，
  // 跟 server.mjs 派生标题那段一致。
  const texts = after.map((m) => (typeof m.content === 'string' ? m.content
    : (Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('') : '')));
  assert.ok(texts.some((s) => s.includes('本地终端刚说的这句')));
});

test('删网关历史只删链接，用户本地 transcript 完好无损', async (t) => {
  const cwd = tmpdir();
  const { root, sid, dir } = fakeLocalHome(t, { cwd });
  const store = makeStore(t);
  const cc = createCcAdapter({ transcripts: store });
  const gwId = cc.adoptLocalSession({ cwd, ccSessionId: sid, gatewaySessionId: randomUUID(), localRoot: root });

  const local = join(dir, `${sid}.jsonl`);
  const before = readFileSync(local, 'utf8');
  assert.equal(statSync(local).nlink, 2);

  store.remove(gwId);

  assert.ok(existsSync(local), '本地原件还在');
  assert.equal(readFileSync(local, 'utf8'), before, '内容一个字节没动');
  assert.equal(statSync(local).nlink, 1, 'link count 降回 1，说明只删了链接');
  assert.equal(cc.restore(gwId), null, '记录没了，restore 不再命中');
});

test('建不了私有目录时不落记录、不抛错，会话宁可不可见', async (t) => {
  // 真机上对应 EXDEV（本地 ~/.claude 与 store 不在同一文件系统）。造不出可靠的
  // 跨文件系统场景，而 Node 24 的 ESM 命名导入改不了、也没有 mock.module
  // （实测：createRequire 打补丁对 ESM 无效），所以用**真实的失败路径**触发
  // 同一个 catch：把 <store>/<id>.cc 占成文件，mkdirSync(slugDir) 抛 ENOTDIR。
  const cwd = tmpdir();
  const { root, sid } = fakeLocalHome(t, { cwd });
  const store = makeStore(t);
  const cc = createCcAdapter({ transcripts: store });
  const gwId = randomUUID();
  const blocked = store.companionDir(gwId);
  writeFileSync(blocked, 'not a dir\n'); // 占住 companionDir 这个名字

  let id;
  try {
    id = cc.adoptLocalSession({ cwd, ccSessionId: sid, gatewaySessionId: gwId, localRoot: root });
  } finally {
    rmSync(blocked, { force: true });
  }
  assert.equal(id, null, '没接上');
  assert.equal(store.list({}).length, 0, '没有留下半条记录');
  // 本地原件没被这次失败动过
  assert.ok(existsSync(join(root, 'projects', String(cwd).replace(/[/.]/g, '-'), `${sid}.jsonl`)));
});

test('没有本地会话（目录不存在）→ 空列表，不抛错', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'atbx-localcc-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cc = createCcAdapter({ transcripts: makeStore(t) });

  assert.deepEqual(cc.localSessions(tmpdir(), root), []);
  // localRoot 整个不存在也一样
  assert.deepEqual(cc.localSessions(tmpdir(), join(root, 'nope')), []);
  assert.deepEqual(cc.localSessions('', root), [], '没 cwd 就不猜');
});

test('slug 把点也转成连字符（只转 / 的实现必须在这里红）', async (t) => {
  // 含点的路径：CLI 写的 slug 是 -tmp-atbx-dot-a，只转 / 会留下点、推出另一个
  // 名字，于是导入静默失效（目录根本对不上）。
  const cwd = join(tmpdir(), 'atbx-dot.a');
  mkdirSync(cwd, { recursive: true });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const { root, sid } = fakeLocalHome(t, { cwd });

  const store = makeStore(t);
  const cc = createCcAdapter({ transcripts: store });
  const [hit] = cc.localSessions(cwd, root);
  assert.ok(hit, '含点路径也要能发现会话');
  assert.equal(hit.ccSessionId, sid);

  const gwId = cc.adoptLocalSession({ cwd, ccSessionId: sid, gatewaySessionId: randomUUID(), localRoot: root });
  assert.ok(gwId, '含点路径也要能导入');
  const landed = join(store.companionDir(gwId), 'projects', '-tmp-atbx-dot-a', `${sid}.jsonl`);
  assert.ok(existsSync(landed), `链到了点也转掉的 slug 目录：${landed}`);
});

test('同名不同源的已存在目标：不覆盖，直接放弃', async (t) => {
  const cwd = tmpdir();
  const { root, sid } = fakeLocalHome(t, { cwd });
  const store = makeStore(t);
  const cc = createCcAdapter({ transcripts: store });
  const gwId = randomUUID();
  const slug = String(cwd).replace(/[/.]/g, '-');
  const slugDir = join(store.companionDir(gwId), 'projects', slug);
  const target = join(slugDir, `${sid}.jsonl`);
  // 预置一个同名但不同源的文件（不是链过来的）
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(target, 'not the same file\n');

  assert.equal(cc.adoptLocalSession({ cwd, ccSessionId: sid, gatewaySessionId: gwId, localRoot: root }), null);
  assert.equal(readFileSync(target, 'utf8'), 'not the same file\n', '没被覆盖');
});

test('真 CLI 聊一轮后本地原件的 inode 不变（硬链接的地基）', async (t) => {
  // 这条钉的是：**CLI 是 append-only，不 rename 替换写**。若哪天改成换 inode 的
  // 写法，导入会话的网关视图会停在一份旧快照上、悄悄分叉——那时必须知道。
  // 没装 claude 就 skip（CI 环境不该因此红）。
  if (!(await createCcAdapter().available())) { t.skip('claude CLI not installed'); return; }
  const { baseUrl } = await startFakeAnthropic(t);
  const cwd = mkdtempSync(join(tmpdir(), 'atbx-cli-cwd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const store = makeStore(t);
  const cc = createCcAdapter({ transcripts: store });
  const SID = randomUUID();
  const events = await withTimeout(collect(cc.run({
    messages: [{ role: 'user', content: '本轮用来验证 inode' }],
    model: 'claude-sonnet-4-5', apiKey: 'k', baseUrl, cwd, allowedTools: [],
    sessionId: SID,
  })), 120_000, 'turn');
  assert.equal(events.at(-1).type, 'turn_end', `turn errored: ${events.at(-1).message}`);

  const rec = store.get(SID);
  assert.ok(rec?.ccSessionId, 'cc session id persisted');
  const local = join(rec.configDir, 'projects', String(cwd).replace(/[/.]/g, '-'), `${rec.ccSessionId}.jsonl`);
  const before = statSync(local);
  assert.equal(before.nlink, 1, '网关自己那份还没被导入过');

  // 现在把它当「本地 CLI 会话」导入（本地 = 网关自己刚写的这个私有目录），
  // 再跑一轮真 CLI，然后看 inode / link count 有没有变。
  const gwId = cc.adoptLocalSession({
    cwd, ccSessionId: rec.ccSessionId, gatewaySessionId: randomUUID(),
    localRoot: rec.configDir, // 私有 dir 里也有 projects/<slug>/<id>.jsonl，同一形状
  });
  assert.ok(gwId, '导入成功');
  assert.equal(statSync(local).nlink, 2, '导入后同一 inode 有两个名字');

  const events2 = await withTimeout(collect(cc.run({
    messages: [{ role: 'user', content: '第二轮，紧接着导入之后' }],
    model: 'claude-sonnet-4-5', apiKey: 'k', baseUrl, cwd, allowedTools: [],
    sessionId: SID, resumeSessionId: rec.ccSessionId,
  })), 120_000, 'turn 2');
  assert.equal(events2.at(-1).type, 'turn_end', `turn 2 errored: ${events2.at(-1).message}`);

  const after = statSync(local);
  assert.equal(after.ino, before.ino, 'CLI append 没换 inode');
  assert.equal(after.nlink, 2, 'link count 也没变');
  assert.ok(after.size > before.size, '文件确实长了（真的又写了一轮）');
  // 而且导入的网关视图看得见新那一轮
  const seen = cc.restore(gwId).messages;
  assert.ok(seen.some((m) => {
    const text = typeof m.content === 'string' ? m.content
      : (Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('') : '');
    return text.includes('第二轮');
  }), '导入的视图看不到 CLI 刚写的第二轮');
});

test('重复导入同一会话是幂等的（同 inode，不重复落记录）', async (t) => {
  const cwd = tmpdir();
  const { root, sid } = fakeLocalHome(t, { cwd });
  const store = makeStore(t);
  const cc = createCcAdapter({ transcripts: store });
  const gwId = randomUUID();

  assert.equal(cc.adoptLocalSession({ cwd, ccSessionId: sid, gatewaySessionId: gwId, localRoot: root }), gwId);
  assert.equal(cc.adoptLocalSession({ cwd, ccSessionId: sid, gatewaySessionId: gwId, localRoot: root }), gwId);
  assert.equal(store.list({}).length, 1, '还是一条记录');
});
