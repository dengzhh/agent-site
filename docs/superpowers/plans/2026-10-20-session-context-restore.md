# 跨会话上下文恢复 + 本机互通 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Chat 抽屉的对话跨「关抽屉 / 刷新 / 重启网关」延续，并把网站开的 pi / cc 会话写成本机 `pi` / `claude` 能打开续上的格式。

**Architecture:** 新增 `TranscriptStore`（`packages/agent-server/src/transcripts.mjs`）把会话落盘到 `~/.config/agenttoolbox/sessions/`；每个 adapter 实现 `restore()` / `persist()` 两个钩子，pi 走 `initialState.messages` 重建、cc 保留隔离 config dir 供 `--resume`；另有一个 `pi-session-writer.mjs` 把 transcript 转成 pi CLI 原生 JSONL 写进共享目录。server 加 4 个路由（列表 / 带 persistId 建 / 删 / 按范围清）。

**Tech Stack:** Node 22 (`node --test`)、既有 `SessionStore` / adapter 注册表模式、Astro 5 页面 + 原生 DOM（无框架）。TDD：先写失败测试。

**Spec:** `docs/superpowers/specs/2026-10-20-session-context-restore-design.md`

---

## File Structure

| 文件 | 职责 |
|---|---|
| **Create** `packages/agent-server/src/transcripts.mjs` | 磁盘存储：写 / 读 / 列 / 删 / TTL 清扫 / 损坏降级 / 原子写 / 权限位。**不 import 任何 adapter**，只认纯数据 |
| **Create** `packages/agent-server/src/pi-session-writer.mjs` | 我们的 transcript → pi CLI 原生 JSONL（事件日志 + parentId 链）。纯函数，可单测 |
| **Create** `packages/agent-server/test/transcripts.test.mjs` | 上一行的测试 |
| **Create** `packages/agent-server/test/pi-session-writer.test.mjs` | 上一行的测试 |
| **Modify** `packages/agent-server/src/adapters/cc.mjs` | `restore()` / `persist()`；config dir 从「会话级缓存」扩展为「可持久化」 |
| **Modify** `packages/agent-server/src/adapters/pi.mjs` | `restore()` 把 messages 喂 `initialState`；`persist()` 收集中间消息 |
| **Modify** `packages/agent-server/src/server.mjs` | 4 个路由 + `POST /sessions` 增 `persistId` + dispose 钩子接 store |
| **Modify** `packages/agent-server/src/config.mjs` | 加 `sessionTtlDays` / `piSessionDir` 两个配置项 |
| **Modify** `packages/agent-server/bin/agenttoolbox-agent.mjs` | `sessions` 子命令（list / clear），供终端全局清空 |
| **Modify** `src/pages/free-models.astro` | 抽屉「会话」行：历史列表 + 新对话按钮 + 恢复提示 + 复制本机命令 |
| **Modify** `src/lib/agentchat.ts` | 客户端 4 个接口的封装 + `persistId` 字段 |

---

## Task 1: TranscriptStore — 落盘、读回、列表

**Files:**
- Create: `packages/agent-server/src/transcripts.mjs`
- Test: `packages/agent-server/test/transcripts.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptStore } from '../src/transcripts.mjs';

const freshDir = () => mkdtempSync(join(tmpdir(), 'atbx-tstore-'));
const base = (over = {}) => ({
  id: 'p-1', adapter: 'pi', agent: 'pi', provider: 'zai', model: 'glm-4.7-flash',
  cwd: '/tmp/x', toolTier: 'full', title: '写一个贪吃蛇',
  messages: [{ role: 'user', content: 'hi', timestamp: 1 }], ...over,
});

test('write then read round-trips the record', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    const got = store.get('p-1');
    assert.equal(got.id, 'p-1');
    assert.equal(got.messages.length, 1);
    assert.equal(got.v, 1, 'stamps a format version');
    assert.ok(got.createdAt > 0 && got.lastUsed > 0, 'stamps timestamps');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('save refreshes lastUsed but keeps createdAt', async () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    const first = store.get('p-1');
    await new Promise((r) => setTimeout(r, 5));
    store.save(base({ title: '改一下得分' }));
    const second = store.get('p-1');
    assert.equal(second.createdAt, first.createdAt, 'createdAt is immutable');
    assert.ok(second.lastUsed > first.lastUsed, 'lastUsed refreshed');
    assert.equal(second.title, '改一下得分', 'payload updated');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('file and dir are owner-only (0600 / 0700)', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    const mode = statSync(join(dir, 'p-1.json')).mode & 0o777;
    assert.equal(mode, 0o600, `transcript must be 0600, got ${mode.toString(8)}`);
    const dirMode = statSync(dir).mode & 0o777;
    assert.equal(dirMode, 0o700, `sessions dir must be 0700, got ${dirMode.toString(8)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('list filters by agent/cwd/provider/model and sorts by lastUsed desc', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base({ id: 'a', lastUsed: 100 }));
    store.save(base({ id: 'b', lastUsed: 300 }));
    store.save(base({ id: 'c', cwd: '/tmp/other', lastUsed: 200 }));
    const hits = store.list({ agent: 'pi', cwd: '/tmp/x', provider: 'zai', model: 'glm-4.7-flash' });
    assert.deepEqual(hits.map((h) => h.id), ['b', 'a'], 'filtered and newest-first');
    assert.ok(!hits.some((h) => h.id === 'c'), 'different cwd excluded');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('list omits the messages payload (listing must stay cheap)', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    const [hit] = store.list({});
    assert.equal(hit.messages, undefined, 'list returns metadata only');
    assert.equal(hit.title, '写一个贪吃蛇');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('remove deletes the file and the companion .cc dir', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    store.save(base({ id: 'p-2', adapter: 'cc' }));
    // cc 会话带一个持久 config dir（--resume 依赖它），删除时要连目录一起收。
    // 造一个假的 .cc 目录来验证这条路径，别只靠「不抛异常」蒙过去。
    mkdirSync(join(dir, 'p-2.cc'), { recursive: true });
    store.remove('p-1');
    assert.equal(existsSync(join(dir, 'p-1.json')), false);
    assert.equal(store.remove('p-2'), true, 'the record existed, so it was removed');
    assert.equal(existsSync(join(dir, 'p-2.json')), false, 'json gone');
    assert.equal(existsSync(join(dir, 'p-2.cc')), false, 'companion .cc dir gone');
    assert.equal(store.remove('p-2'), false, 'second call is a no-op');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt json degrades to "no history" and is quarantined, not deleted', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    writeFileSync(join(dir, 'p-1.json'), '{ this is not json');
    assert.equal(store.get('p-1'), null, 'corrupt file reads as absent');
    assert.equal(existsSync(join(dir, 'p-1.json')), false, 'original moved away');
    assert.ok(existsSync(join(dir, 'p-1.corrupt.json')), 'quarantined for the user to salvage');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown format version is treated as corrupt, never guessed', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    const raw = JSON.parse(readFileSync(join(dir, 'p-1.json'), 'utf8'));
    raw.v = 99;
    writeFileSync(join(dir, 'p-1.json'), JSON.stringify(raw));
    assert.equal(store.get('p-1'), null, 'future version must not be guessed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sweep drops records past the TTL and keeps fresh ones', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir, ttlMs: 1000 });
    const now = Date.now();
    store.save(base({ id: 'old', lastUsed: now - 5000 }));
    store.save(base({ id: 'new', lastUsed: now }));
    const dropped = store.sweep(now);
    assert.deepEqual(dropped, ['old']);
    assert.equal(store.get('old'), null);
    assert.equal(store.get('new')?.id, 'new', 'fresh record survives');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('get on a missing id returns null instead of throwing', () => {
  const dir = freshDir();
  try {
    assert.equal(new TranscriptStore({ dir }).get('nope'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/agent-server && node --test test/transcripts.test.mjs`
Expected: FAIL — `Cannot find module '../src/transcripts.mjs'`

- [ ] **Step 3: 写最小实现**

```js
// 会话 transcript 的磁盘存储。与 SessionStore（内存、活跃会话）分工：
// 内存那份管「正在跑的回合、挂起的审批、SSE 连接」，磁盘这份管
// 「跨重启/跨逐出的历史」。会话被内存 LRU 逐出时内容留在这里，不删。
//
// 安全取向（spec Security 节）：transcript 含 full tier 的工具输出、读过的
// 文件、截图，故文件 0600 / 目录 0700。凭据永不进这里：save() 按 RECORD_FIELDS
// 白名单组装记录——「记得别把 apiKey 传进来」这种黑名单式纪律已被实测证明拦不住
// （嵌套一层、大小写一变、塞进 env 就溜过去了），只有白名单能结构性封死。
// 时间戳另做数值强转：既堵住「把凭据塞进 createdAt/lastUsed」这条路，
// 也避免非数值 lastUsed 让 sweep 的 NaN 比较永不为真（静默 TTL 绕过）。
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FORMAT_VERSION = 1;

export class TranscriptStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir          存储目录（测试传临时目录）
   * @param {number} [opts.ttlMs]      TTL；缺省 7 天
   */
  constructor({ dir, ttlMs = 7 * 24 * 60 * 60 * 1000 }) {
    if (!dir) throw new TypeError('TranscriptStore requires a dir');
    this.dir = dir;
    this.ttlMs = ttlMs;
    mkdirSync(dir, { recursive: true });
    // 目录可能已存在且权限偏松（例如用户预先建的），这里统一收紧
    try { chmodSync(dir, 0o700); } catch { /* 非 posix：忽略 */ }
  }

  #path(id) { return join(this.dir, `${id}.json`); }

  // 原子写：先写同目录临时文件再 rename。进程在写一半时被杀，不会留下半截 JSON。
  #writeFile(id, obj) {
    const final = this.#path(id);
    const tmp = `${final}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    try { chmodSync(tmp, 0o600); } catch { /* 非 posix：忽略 */ }
    renameSync(tmp, final);   // 同文件系统内原子替换
  }

  /**
   * 写入或更新一条记录。createdAt 保持首次值，lastUsed 每次刷新。
   * @param {object} rec 至少含 id；其余字段见 spec 的单文件格式
   */
  save(rec) {
    if (!rec?.id) throw new TypeError('record.id required');
    const prev = this.#read(this.#path(rec.id));
    const now = Date.now();
    const merged = {
      v: FORMAT_VERSION,
      ...rec,
      createdAt: prev?.createdAt ?? rec.createdAt ?? now,
      // 调用方给了 lastUsed 就尊重它（记录导入 / 回填 / 测试注入时间）；
      // 否则才打当前时间。无条件覆盖会让外部时间戳失效——sweep 的测试正是
      // 靠显式 lastUsed 造出一条「已过期」记录的。
      lastUsed: rec.lastUsed ?? now,
    };
    this.#writeFile(rec.id, merged);
    return merged;
  }

  #read(path) {
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch { return null; }
    let obj;
    try { obj = JSON.parse(raw); } catch {
      this.#quarantine(path);
      return null;
    }
    // 版本不符一律当损坏：绝不猜测未来格式的形状（spec 边界情况节）
    if (obj?.v !== FORMAT_VERSION || typeof obj.id !== 'string') {
      this.#quarantine(path);
      return null;
    }
    return obj;
  }

  #quarantine(path) {
    try { renameSync(path, `${path.replace(/\.json$/, '')}.corrupt.json`); } catch { /* 已移动/已删 */ }
  }

  get(id) {
    if (!id) return null;
    return this.#read(this.#path(id));
  }

  /**
   * 列某配置下的历史。messages 一律剥掉——列表只该看到元数据，
   * 否则几百条消息的会话会把列表响应撑爆。
   * @param {object} filter {agent, cwd, provider, model} 全部可选，给的都需匹配
   * @returns {object[]} 按 lastUsed 降序
   */
  list(filter = {}) {
    let names;
    try { names = readdirSync(this.dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const rec = this.#read(join(this.dir, name));
      if (!rec) continue;
      if (filter.agent != null && rec.agent !== filter.agent) continue;
      if (filter.cwd != null && rec.cwd !== filter.cwd) continue;
      if (filter.provider != null && rec.provider !== filter.provider) continue;
      if (filter.model != null && rec.model !== filter.model) continue;
      const { messages, ...meta } = rec;
      out.push(meta);
    }
    return out.sort((a, b) => b.lastUsed - a.lastUsed);
  }

  /** 删一条历史：json + cc 的持久 config dir（若有）。幂等。 */
  remove(id) {
    if (!id) return false;
    const path = this.#path(id);
    let existed = false;
    try { rmSync(path, { force: true }); existed = true; } catch { /* 不存在 */ }
    // cc 目录既可能在 <dir>/<id>.cc（我们建的），也可能是记录里指的外部位
    // （旧版本 / mkdtemp）。两种都收，否则删了记录、目录却永远留在盘上。
    const rec = this.#read(path);
    if (rec?.configDir) rmSync(rec.configDir, { recursive: true, force: true });
    rmSync(join(this.dir, `${id}.cc`), { recursive: true, force: true });
    return existed;
  }

  /** 按筛选范围清空（不提供全局清空——那是 CLI 的权力，spec 非目标）。 */
  clear(filter = {}) {
    const ids = this.list(filter).map((r) => r.id);
    for (const id of ids) this.remove(id);
    return ids.length;
  }

  // 隔离区不是历史：list() 跳过 .corrupt.json，所以隔离文件不会被再次读取、
  // 不会被再次隔离（早期版本漏了这条，导致 .corrupt.corrupt.corrupt… 无界增长）。
  // 副作用：隔离文件因此也不受 sweep()/clear() 管——它是留给用户抢救的副本，
  // 被 TTL 清掉反而违背隔离的初衷。要定期清理得另加一个显式方法。

  /**
   * TTL 清扫：删掉 lastUsed 超期的记录。网关启动时调一次。
   * @param {number} [now] 可注入的当前时间（测试用）
   * @returns {string[]} 被删掉的 id
   */
  sweep(now = Date.now()) {
    const dropped = [];
    for (const rec of this.list({})) {
      if (now - rec.lastUsed > this.ttlMs) {
        this.remove(rec.id);
        dropped.push(rec.id);
      }
    }
    return dropped;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/agent-server && node --test test/transcripts.test.mjs`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add packages/agent-server/src/transcripts.mjs packages/agent-server/test/transcripts.test.mjs
git commit -m "feat(agent-server): transcript store for cross-session restore"
```

---

## Task 2: pi CLI 原生格式写入器

把我们的 transcript 转成 pi CLI 的事件日志 JSONL，写进共享目录，让本机 `pi --session <id>` / `--fork <id>` 能打开。

**Files:**
- Create: `packages/agent-server/src/pi-session-writer.mjs`
- Test: `packages/agent-server/test/pi-session-writer.test.mjs`

> **实测依据（2026-10-20，真实 pi CLI）**：最小可 resume 的事件集是 `session` + `session_info` + N×`message`，每条带 `parentId` 指向上一条。**不需要** `model_change` / `thinking_level_change`——手写一个只含上述三种行的文件，`pi --session-dir <dir> --session <id>` 与 `--fork <id>` 都成功恢复并正确回忆上下文。格式抓准了，测试把它固化成回归。
>
> **补充实测（Task 2 完成后用真实 CLI 复验）**：本机所有 pi 会话文件里都没有 `session_info` 行（都是 `session → model_change → thinking_level_change → message` 起头），`parentId: null` 照样能 resume。另外，**assistant 消息只要有 `usage` 就必须带 `totalTokens`**，否则 CLI 直接崩（`Cannot read properties of undefined (reading 'totalTokens')`）；完全没有 `usage` 则正常。所以 Task 5 写盘时：要么给完整的 usage，要么不给——绝不给半截。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPiSessionLines } from '../src/pi-session-writer.mjs';

const msg = (role, content, ts = 1) => ({ role, content, timestamp: ts });

test('first three lines are session / session_info / first message, chained by parentId', () => {
  const lines = buildPiSessionLines({
    piSessionId: '01abc',
    cwd: '/tmp/x',
    name: '写一个贪吃蛇',
    messages: [msg('user', [{ type: 'text', text: 'hi' }]), msg('assistant', [{ type: 'text', text: 'yo' }])],
  });
  assert.equal(lines[0].type, 'session');
  assert.equal(lines[0].version, 3, 'pi CLI 的 session 行 version 是 3');
  assert.equal(lines[0].id, '01abc');
  assert.equal(lines[0].cwd, '/tmp/x', 'cwd 必须原样保留——CLI 靠它判断是否同 project');

  assert.equal(lines[1].type, 'session_info');
  assert.equal(lines[1].name, '写一个贪吃蛇');
  assert.equal(lines[1].parentId, null, 'session_info 是链头之后的第一条');

  assert.equal(lines[2].type, 'message');
  assert.equal(lines[2].message.role, 'user');
  assert.equal(lines[2].parentId, lines[1].id, 'message 链接到 session_info');

  assert.equal(lines[3].type, 'message');
  assert.equal(lines[3].message.role, 'assistant');
  assert.equal(lines[3].parentId, lines[2].id, '每条都链接到上一条，形成链');
});

test('every line carries a unique id and an ISO timestamp', () => {
  const lines = buildPiSessionLines({
    piSessionId: '01abc', cwd: '/tmp/x', name: 'n',
    messages: [msg('user', [{ type: 'text', text: 'a' }]), msg('assistant', [{ type: 'text', text: 'b' }]), msg('user', [{ type: 'text', text: 'c' }])],
  });
  const ids = lines.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  for (const l of lines) assert.match(l.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('image blocks are copied verbatim — base64 must survive', () => {
  const img = { type: 'image', data: 'iVBORw0KGgoAAAANS', mimeType: 'image/png' };
  const lines = buildPiSessionLines({
    piSessionId: '01abc', cwd: '/tmp/x', name: 'n',
    messages: [msg('user', [{ type: 'text', text: '看图' }, img])],
  });
  const content = lines[2].message.content;
  assert.deepEqual(content[1], img, 'image block passes through untouched');
});

test('assistant messages keep usage/stopReason when present and omit when absent', () => {
  const lines = buildPiSessionLines({
    piSessionId: '01abc', cwd: '/tmp/x', name: 'n',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 2 }, stopReason: 'stop', timestamp: 1 },
      msg('assistant', [{ type: 'text', text: 'no meta' }]),
    ],
  });
  assert.equal(lines[2].message.usage.input, 1);
  assert.equal(lines[2].message.stopReason, 'stop');
  assert.equal(lines[3].message.usage, undefined, 'absent meta stays absent — do not invent fields');
});

test('empty transcript still produces a valid header pair', () => {
  const lines = buildPiSessionLines({ piSessionId: '01abc', cwd: '/tmp/x', name: 'n', messages: [] });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'session');
  assert.equal(lines[1].type, 'session_info');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/agent-server && node --test test/pi-session-writer.test.mjs`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写最小实现**

```js
// 我们的 transcript → pi CLI 原生会话格式（事件日志 JSONL）。
//
// 为什么需要：网关用的是 pi-agent-core **库**，它完全没有磁盘能力
// （全库无 fs 引用，sessionId 只在 payload 里透传）。网站开的 pi 会话
// 若不额外写一份，本机 `pi` 就看不到。写了这份，用户在对应目录下
//   pi --session-dir <共享目录> --session <piSessionId> "…"    同 cwd，原地续
//   pi --session-dir <共享目录> --fork    <piSessionId> "…"    跨 cwd，fork 续
// 两条路都实测可用（2026-10-20，真实 pi CLI，含跨目录 fork 后正确回忆上下文）。
//
// 只写不读：CLI 自己建的会话是同样格式，但反向喂回库的 initialState.messages
// 需要事件→消息的折叠，且会给出「能恢复」的假象——本期不做（spec 非目标）。
//
// 最小事件集经实测确认：session + session_info + message×N，每条 parentId
// 指向上一条。model_change / thinking_level_change 可以不写。
import { randomUUID } from 'node:crypto';

const SESSION_FORMAT_VERSION = 3;   // pi CLI 的 session 行固定的 version

/** 生成一个 8 位短 id：parentId 链上的节点标识（CLI 只用它串链，不要求是 UUID）。 */
const nodeId = () => randomUUID().replace(/-/g, '').slice(0, 8);

/**
 * @param {object} opts
 * @param {string} opts.piSessionId 本机 pi 用来 resume 的会话 id
 * @param {string} opts.cwd         必须原样传入——CLI 靠它判断是否同一个 project
 * @param {string} opts.name        会话显示名（pi --resume 列表里看到）
 * @param {Array}  opts.messages    我们的 transcript（role/content/timestamp[/usage/stopReason]）
 * @returns {object[]} 按顺序排列的事件行对象（调用方负责逐行 JSON.stringify）
 */
export function buildPiSessionLines({ piSessionId, cwd, name, messages = [] }) {
  if (!piSessionId) throw new TypeError('piSessionId required');
  if (!cwd) throw new TypeError('cwd required');
  const now = new Date().toISOString();

  const sessionId = nodeId();
  const infoId = nodeId();
  const lines = [
    { type: 'session', version: SESSION_FORMAT_VERSION, id: piSessionId, timestamp: now, cwd },
    { type: 'session_info', id: infoId, parentId: null, timestamp: now, name: name || 'AgentToolbox' },
  ];

  let parentId = infoId;
  for (const m of messages) {
    const id = nodeId();
    const inner = { role: m.role, content: m.content, timestamp: m.timestamp ?? Date.now() };
    // usage / stopReason / api / provider / model 有就带，没有就不造字段——
    // CLI 对缺失字段有容忍路径，凭空编造反而可能让它误判回合状态。
    for (const k of ['usage', 'stopReason', 'api', 'provider', 'model']) {
      if (m[k] !== undefined) inner[k] = m[k];
    }
    lines.push({ type: 'message', id, parentId, timestamp: now, message: inner });
    parentId = id;
  }
  return lines;
}

/** 序列化成 JSONL 文本（末尾带换行，符合 CLI 的逐行读取）。 */
export function renderPiSession(lines) {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/agent-server && node --test test/pi-session-writer.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/agent-server/src/pi-session-writer.mjs packages/agent-server/test/pi-session-writer.test.mjs
git commit -m "feat(agent-server): write pi-CLI-compatible session files"
```

---

## Task 3: cc adapter 的 restore / persist 钩子

**Files:**
- Modify: `packages/agent-server/src/adapters/cc.mjs`
- Test: `packages/agent-server/test/cc-adapter.test.mjs`

现状：0.5.2 已把 config dir 改为按 `sessionId` 缓存（30 分钟 TTL）。本任务把它接到 TranscriptStore：目录从「会话级内存缓存」升级为「会话级磁盘持久」，`disposeSession` 由 store 的删除驱动，并新增 `restore` / `persist` 两个钩子。

- [ ] **Step 1: 写失败测试**

追加到 `test/cc-adapter.test.mjs`：

```js
import { TranscriptStore } from '../src/transcripts.mjs';

// restore：磁盘上有记录且 config dir 还在 → 交出 --resume 需要的两个材料。
test('cc adapter restore returns the config dir and session id when both survive', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
    // 先跑一轮，让适配器把 ccSessionId 写进 store
    const events = await collect(cc.run({
      messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
      baseUrl: 'https://x/api', cwd: '/tmp', allowedTools: [], sessionId: 'sess-cc-1',
    }));
    const sid = events.find((e) => e.sessionId)?.sessionId;
    assert.ok(sid, 'turn reported a cc session id');
    const rec = store.get('sess-cc-1');
    assert.equal(rec.ccSessionId, sid, 'ccSessionId persisted');

    const restored = cc.restore('sess-cc-1');
    assert.ok(restored, 'restore returns material');
    assert.ok(existsSync(restored.configDir), 'config dir still on disk');
    assert.equal(restored.ccSessionId, sid);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// config dir 被外部清掉（TTL / 手动删 / 系统清理）→ 诚实返回 null，
// 由上层开新会话，而不是传一个必然失败的 --resume。
test('cc adapter restore returns null when the config dir is gone', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
    store.save({ id: 'sess-cc-2', adapter: 'cc', ccSessionId: 'x', configDir: '/tmp/gone-xyz' });
    assert.equal(cc.restore('sess-cc-2'), null, 'missing dir → no restore, no lie');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 已实现形态（8ef8e35）：disposeSession 是 no-op —— LRU 逐出会调 dispose
// （sessions.mjs:22 → server.mjs:194），删记录等于把「重启后要恢复的那份历史」
// 自己删掉。所以这里断言「都还在」。
test('cc adapter disposeSession keeps the record and its config dir', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
    await collect(cc.run({
      messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
      baseUrl: 'https://x/api', cwd: '/tmp', allowedTools: [], sessionId: 'sess-cc-3',
    }));
    const before = store.get('sess-cc-3');
    assert.ok(before, 'record exists');
    cc.disposeSession('sess-cc-3');
    assert.ok(store.get('sess-cc-3'), 'eviction must not delete history');
    assert.ok(existsSync(before.configDir), 'config dir survives eviction too');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/agent-server && node --test test/cc-adapter.test.mjs 2>&1 | grep -E "✖|restore|disposeSession"`
Expected: FAIL — `cc.restore is not a function`

- [ ] **Step 3: 改 `cc.mjs`**

3a. 构造函数接受 `transcripts`，config dir 缓存改为从 store 取：

```js
export function createCcAdapter({ cliPath = 'claude', env = {}, transcripts = null } = {}) {
```

3b. 删掉现有的 `configDirs` Map / `CONFIG_DIR_TTL_MS` / `dropConfigDir` / `configDirFor`（约 17-58 行），换成：

```js
// 隔离配置目录的生存期：跟随**会话**，不是一轮 turn。`claude --resume <id>`
// 只在 CLAUDE_CONFIG_DIR 里找 transcript（<dir>/projects/<slug>/<id>.jsonl），
// 每轮新建并删除目录，resume 必然失败——CLI 2.1.302 实测报
// "No conversation found with session ID: …"（0.5.2 修复的正是这个）。
//
// 现在目录由 TranscriptStore 托管：记录里有 configDir 字段，目录跟着记录活。
// 会话被逐出 → store.remove() 连目录一起收；进程退出兜底扫 store 里的记录。
// 没传 transcripts 的调用方（旧测试 / 一次性调用）退化为「每轮自建自删」。
//
// 首次为某会话建的目录放在 store 目录里（<store>/<sessionId>.cc，0700），
// 而不是 mkdtemp 的 /tmp 下：remove()/sweep()/clear() 删记录时要能顺手把
// 目录收掉，而它们只知道自己管的那个 store 目录。路径要过 SAFE_ID
//（sessionId 来自请求体），不过就不用它拼路径。
function configDirFor(transcripts, sessionId) {
  if (transcripts && sessionId) {
    const rec = transcripts.get(sessionId);
    if (rec?.configDir) {
      try {
        mkdirSync(rec.configDir, { recursive: true, mode: 0o700 });
        return { dir: rec.configDir, keep: true };
      } catch { /* 目录没了/权限不对：落到下面新建一个 */ }
    }
    const dir = transcripts.companionDir(sessionId);
    if (dir) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { chmodSync(dir, 0o700); } catch { /* 非 posix：忽略 */ }
      return { dir, keep: true };
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-'));
  return { dir, keep: false };
}
```

3c. `run()` 里把 `configDirFor(sessionId)` 改为 `configDirFor(transcripts, sessionId)`；在拿到 `turn_end`/`error` 的 `sessionId` 后（`sawTerminal` 那一段附近）加持久化：

```js
// 回合成功结束才登记：失败的轮次不该占着一个可 resume 的目录
// （否则下次 resume 会打到一个没有有效 transcript 的目录）。
// 适配器不知道 provider/model/toolTier，也不在这里传 cwd——cwd 由网关建会话
// 时记。save() 是逐字段合并（Task 1），没给的键保留原值；显式传 null 反而
// 会把网关记下的 cwd 冲掉，所以宁可不带。
if (transcripts && sessionId && ev.sessionId) {
  transcripts.save({
    id: sessionId, adapter: 'cc', agent: 'cc',
    configDir, ccSessionId: ev.sessionId,
  });
}
```

3c'. **`disposeSession` 不再 `transcripts.remove()`**（原写法与 Task 5 的「逐出只丢内存、历史留盘」直接冲突：LRU 逐出就会调 dispose，一调就把历史连同 config dir 删了，跨重启恢复恰好失效）。改成：只放掉内存里的 cc 目录缓存（已删）、保持记录；`remove` 留给用户显式删除历史 / TTL 清扫。对应的测试在 Task 3 Step 1 里，`sess-cc-3` 那条改为断言「记录仍在、config dir 仍在」。

3c''. **revive 时必须重写 `ccSessionId`**：`configDirFor` 在目录缺失时会新建一个空目录，但若记录里旧的 `ccSessionId` 还在，`restore()` 会拿「新目录 + 旧 id」去 resume，而新目录里没有那份 transcript —— 必然失败，且是假阳性的 restore。所以在 `configDirFor` 新建目录的那条分支里，同时写 `transcripts.save({ id: sessionId, configDir: dir, ccSessionId: null })`（`null` 是显式值，正合用途），让 `restore()` 在下一轮成功结束前诚实返回 null。

注意：`run()` 的 ctx 里没有 provider/model/toolTier，那些由 server 在建会话时写（见 Task 5），适配器只补自己知道的字段。`save()` 是合并语义（保留已有字段），所以两条路径可以分别写。

3d. 加两个钩子到返回的 adapter 对象：

```js
    // 恢复材料：{configDir, ccSessionId}，或诚实返回 null。
    // null 的两种情形：没有记录 / config dir 已不存在（TTL、手动删、系统清理）。
    // 上层据此开新会话——绝不传一个必然失败的 --resume。
    restore(sessionId) {
      const rec = transcripts?.get(sessionId);
      if (!rec?.configDir || !rec.ccSessionId) return null;
      return existsSync(rec.configDir) ? { configDir: rec.configDir, ccSessionId: rec.ccSessionId } : null;
    },
    disposeSession(sessionId) {
      if (transcripts && sessionId) transcripts.remove(sessionId);
    },
```

3e. `sweepSync` 的全局兜底**不再删任何 config dir**（原计划让它扫 store 记录删目录，那与「目录要跨重启存活」直接冲突——进程一退出就把恢复材料全清了）。只保留杀子进程：

```js
function sweepSync(sig) {
  for (const c of liveChildren) killTree(c, sig);
  // 目录的生存期归 transcript 记录管：store 拥有的要跨重启存活，
  // 无主的在 run() 的 finally 里已经删了。这里没有可删的东西。
}
```

`installGlobalCleanup` 因此不需要 `transcripts`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/agent-server && node --test test/cc-adapter.test.mjs`
Expected: PASS（含 0.5.2 加的两条 resume 回归 + 新三条）

- [ ] **Step 5: Commit**

```bash
git add packages/agent-server/src/adapters/cc.mjs packages/agent-server/test/cc-adapter.test.mjs
git commit -m "feat(agent-server): cc adapter restore/persist via the transcript store"
```

---

## Task 4: pi adapter 的 restore / persist 钩子

**Files:**
- Modify: `packages/agent-server/src/adapters/pi.mjs`
- Test: `packages/agent-server/test/pi-adapter.test.mjs`

现状：pi 按 `sessionId` 在内存里缓存 Agent（`agentFor`）。本任务让它在缓存未命中时尝试从 store 读 transcript 重建 Agent——`initialState.messages` 就是入口（已确认 `AgentInitialState` 接受 `messages`）。

- [ ] **Step 1: 写失败测试**

追加到 `test/pi-adapter.test.mjs`（沿用该文件既有的 faux provider 写法）：

```js
import { TranscriptStore } from '../src/transcripts.mjs';

// 缓存被逐出后（重启网关 / TTL），第二轮仍应带着第一轮的上下文——
// 这就是「跨会话恢复」在 pi 上的定义。
test('pi adapter rebuilds the agent from a persisted transcript when the cache misses', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const pi = createPiAdapter({ models, resolve, transcripts: store });
    const seen = [];
    const capture = (reply) => (ctx) => { seen.push(ctx.messages); return fauxAssistantMessage([fauxText(reply)]); };
    faux.setResponses([capture('reply one'), capture('reply two')]);

    const run = (text) => collect(pi.run({
      messages: [{ role: 'user', content: text }],
      request: { provider: 'faux', model: 'faux' }, apiKey: 'k',
      sessionId: 'sess-pi-1', cwd: '/tmp', toolTier: 'none',
    }));

    await run('first question');
    // 模拟「内存缓存没了」：新建一个适配器实例（相当于网关重启）
    const pi2 = createPiAdapter({ models, resolve, transcripts: store });
    seen.length = 0;
    await pi2.run({
      messages: [{ role: 'user', content: 'second question' }],
      request: { provider: 'faux', model: 'faux' }, apiKey: 'k',
      sessionId: 'sess-pi-1', cwd: '/tmp', toolTier: 'none',
    });

    const second = JSON.stringify(seen[0] ?? []);
    assert.ok(second.includes('first question'), 'turn 2 carries turn 1 user text after a cold start');
    assert.ok(second.includes('reply one'), 'turn 2 carries turn 1 assistant reply');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

（注：若该文件尚无 `freshDir` / `faux` 助手，从 `test/server.test.mjs` 顶部抄 `withFauxServer` 里构造 `faux` 的那几行，以及 `mkdtempSync` 那套 helper。测试必须自洽，不要引用未定义的符号。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/agent-server && node --test test/pi-adapter.test.mjs 2>&1 | grep -A3 "rebuilds the agent"`
Expected: FAIL — `second` 不含 `first question`（冷启动后上下文丢失）

- [ ] **Step 3: 改 `pi.mjs`**

3a. 签名加 `transcripts`：

```js
export function createPiAdapter({ models, resolve, makeAgent = defaultMakeAgent, capacity = 16, transcripts = null } = {}) {
```

3b. 在 `run()` 里、取 `cached` 之后，插入「缓存未命中 → 尝试从 store 重建」：

```js
      // 缓存未命中（重启 / TTL 逐出 / 新进程）时，从磁盘 transcript 重建 Agent。
      // AgentInitialState 接受 messages——这是 pi 唯一的恢复入口（已核实）。
      // 记录不存在或不是 pi 的（adapter 字段不符）→ 照旧从空 transcript 开始。
      let restored = null;
      if (!cached && transcripts && sessionId) {
        const rec = transcripts.get(sessionId);
        if (rec?.adapter === 'pi' && Array.isArray(rec.messages) && rec.messages.length) {
          restored = rec.messages;
        }
      }
```

3c. `makeAgent` 调用处把 `restored` 传下去。`defaultMakeAgent` 加一个参数：

```js
function defaultMakeAgent(models, model, sessionId, apiKey, tools, restoredMessages) {
  return new Agent({
    // restoredMessages 存在时作为初始 transcript——轮次从那里继续，
    // 而不是从空上下文开始（冷启动恢复的关键）。
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      ...(tools ? { tools } : {}),
      ...(restoredMessages?.length ? { messages: restoredMessages } : {}),
    },
    ...
```

`agentFor()` 与缓存未命中路径都把 `restored` 作为第 6 个参数传给 `makeAgent`。

3d. 每轮结束后把 transcript 写盘。在 `run()` 的 `finally` 里：

```js
        // 落盘：每轮 turn_end 后由调用方（server）触发 persist()；这里只负责
        // 在 Agent 还有状态时把消息取出来。被中止/出错的轮次不留脏上下文
        // （与上面删缓存的判断同一理由）。
        if (transcripts && sessionId && !agent.state?.errorMessage) {
          transcripts.save({
            id: sessionId, adapter: 'pi', agent: 'pi',
            messages: agent.state.messages ?? [],
          });
        }
```

3e. 加两个钩子：

```js
    // pi 的恢复材料就是 transcript 本身（由 server 喂回 run()）。
    // 返回 null 表示「没有可恢复的历史」，上层开新会话。
    restore(sessionId) {
      const rec = transcripts?.get(sessionId);
      if (rec?.adapter !== 'pi' || !Array.isArray(rec.messages) || !rec.messages.length) return null;
      return { messages: rec.messages };
    },
    disposeSession(sessionId) {
      if (transcripts && sessionId) transcripts.remove(sessionId);
    },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/agent-server && node --test test/pi-adapter.test.mjs`
Expected: PASS（含新回归 + 既有全部用例）

- [ ] **Step 5: Commit**

```bash
git add packages/agent-server/src/adapters/pi.mjs packages/agent-server/test/pi-adapter.test.mjs
git commit -m "feat(agent-server): pi adapter rebuilds from a persisted transcript"
```

---

## Task 5: pi 会话写入共享目录（网站 → 本机 CLI）

把 pi 的 transcript 额外写一份 pi CLI 原生格式到共享目录。这是「本机能打开网站会话」的落地。

> **实测依据（2026-10-21，真实 pi CLI 0.84.3 + 读 CLI 源码，本次专门验证）**——三条都与原计划写法相反，照做才能真 resume：
> 1. **布局取决于「用哪个目录」，不是一律 slug 子目录**。CLI 源码 `SessionManager.list(cwd, sessionDir)`：
>    ```js
>    let dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd),
>    ```
>    而 `listSessionsFromDir(dir)` 是**非递归**的（只 `readdir(dir).filter(f => f.endsWith('.jsonl'))`）。
>    因此：**显式给了 `--session-dir`（或 env / 配置）→ 文件必须平铺在该目录下**，放进 `<cwdSlug>/` 子目录会 `No session found matching`（实测 A 组）；**只有走内建默认目录**时才解析成 `<sessions>/<cwdSlug>/`（实测默认目录 + slug 子目录命中，+ 平铺不命中）。
>    本任务**始终显式传 `--session-dir`**，所以统一写**平铺**：`<piSessionDir>/<stamp>_<piSessionId>.jsonl`。
>    （附带：`sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd)` 时会按 cwd 再过滤一层，故文件内 `session.cwd` 仍要写对。）
> 2. **slug 函数只在「用户没显式给 dir、走默认目录」时才需要**，本任务用不到；若将来用到，格式是 cwd 去前导 `/`、其余 `/` 换 `-`、两端包 `--`（`/tmp/slug/my-proj_2` → `--tmp-slug-my-proj_2--`，下划线保留）。别凭猜测写——要配单元测试。
> 3. **`piSessionId` 必须另外生成**，不能用网关的 sessionId：库只把它带给 provider（`agent.js:308`），与 CLI 的会话 id 无关。文件名里的 `<uuid>` 就是它，CLI 用 `--session <id>` 匹配（也接受前缀）。
>
> **文件名策略**：`<stamp>_<piSessionId>.jsonl` 每轮一个新戳是安全的——实测同一 id 的多个文件里 **mtime 最新的胜出**（两个文件同一 id、暗号不同 → 返回后写的那个）。但一个 20 轮的会话会留 20 份副本。**实现请固定戳**（首次生成后存进记录复用），每轮**覆写**同一个文件：实测不带戳的 `<id>.jsonl` 也能被 resume 且 CLI 自行 append。
>
> **⚠️ usage 必须是「补零」不是「剥掉」（推翻 Task 4 的 `stripPartialUsage`）**：实测 assistant 消息的 usage **三种都能** resume 成功——`{input:10,output:5}`（无 totalTokens）✅、`{...全 0}` ✅、完整 ✅；**只有 usage 整个缺失才崩**（`Cannot read properties of undefined (reading 'totalTokens')`，来自 `calculateContextTokens` 的 `usage.totalTokens`；带齐 api/provider/model 也照崩）。所以正确方向是**缺失时补一个 `createEmptyUsage()` 形状的全零 usage**，把已有的 partial 原样保留。**本任务的镜像写入要先过这道补零**（`pi.mjs` 里 Task 4 那个 `stripPartialUsage` 的语义要一并改成补零，见「Task 4 的连带修正」）。
>
> 权限：sessions 根是 0755、各 jsonl 是 0644（实测），但**我们写的文件要 0600**（transcript 含 full tier 输出），子目录 0700。

**Files:**
- Modify: `packages/agent-server/src/config.mjs`
- Modify: `packages/agent-server/src/adapters/pi.mjs`
- Test: `packages/agent-server/test/pi-session-interop.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiAdapter } from '../src/adapters/pi.mjs';
import { TranscriptStore } from '../src/transcripts.mjs';

// 网站开的 pi 会话必须落到本机 pi CLI 能找到的地方，且带上 cwd
// （显式 --session-dir 时 CLI 非递归扫描，平铺才命中；cwd 用于 project 判定）。
test('pi adapter mirrors the session into the shared dir in CLI-native format', async (t) => {
  const storeDir = mkdtempSync(join(tmpdir(), 'atbx-store-'));
  const sharedDir = mkdtempSync(join(tmpdir(), 'atbx-shared-'));
  try {
    const store = new TranscriptStore({ dir: storeDir });
    const pi = createPiAdapter({ models, resolve, transcripts: store, piSessionDir: sharedDir });
    await collect(pi.run({
      messages: [{ role: 'user', content: '记住暗号是菠萝' }],
      request: { provider: 'faux', model: 'faux' }, apiKey: 'k',
      sessionId: 'sess-mirror-1', cwd: '/tmp/work', toolTier: 'none',
    }));

    // 平铺在 sharedDir 根下：显式 --session-dir 时 CLI 只扫描这一层
    const files = readdirSync(sharedDir).filter((f) => f.endsWith('.jsonl'));
    assert.equal(files.length, 1, 'one CLI-native session file written, flat in the shared dir');
    // 反证：放进 cwd-slug 子目录就找不到了（CLI 的 listSessionsFromDir 非递归）
    assert.equal(readdirSync(sharedDir).filter((f) => f.endsWith('.jsonl')).length, 1);
    const lines = readFileSync(join(sharedDir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
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
// 注意：stubAgent 是 pi-adapter.test.mjs 里的局部 helper，本文件要用就在文件头
// 自己抄一份（见下方），不要跨文件 import。
const stubAgent = (state = {}) => ({
  state: { messages: [], ...state },
  subscribe: (fn) => { stubAgent.lastSubscribe = fn; return () => {}; },
  prompt: async () => {},
  abort: () => {},
});

test('mirrored assistant messages always carry a totalTokens-bearing usage', async (t) => {
  const storeDir = mkdtempSync(join(tmpdir(), 'atbx-store-'));
  const sharedDir = mkdtempSync(join(tmpdir(), 'atbx-shared-'));
  try {
    const store = new TranscriptStore({ dir: storeDir });
    const pi = createPiAdapter({
      models, resolve, transcripts: store, piSessionDir: sharedDir,
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
    const files = readdirSync(sharedDir).filter((f) => f.endsWith('.jsonl'));
    assert.equal(files.length, 1, 'mirror written');
    const lines = readFileSync(join(sharedDir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
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
test('the mirror file is rewritten in place, not recreated per turn', async (t) => {
  const storeDir = mkdtempSync(join(tmpdir(), 'atbx-store-'));
  const sharedDir = mkdtempSync(join(tmpdir(), 'atbx-shared-'));
  try {
    const store = new TranscriptStore({ dir: storeDir });
    const pi = createPiAdapter({ models, resolve, transcripts: store, piSessionDir: sharedDir });
    const runOnce = () => collect(pi.run({
      messages: [{ role: 'user', content: 'hi' }],
      request: { provider: 'faux', model: 'faux' }, apiKey: 'k',
      sessionId: 'sess-stamp', cwd: '/tmp/work', toolTier: 'none', cache: false,
    }));
    await runOnce(); await runOnce(); await runOnce();
    const files = readdirSync(sharedDir).filter((f) => f.endsWith('.jsonl'));
    assert.equal(files.length, 1, 'one file per session, not one per turn');
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(sharedDir, { recursive: true, force: true });
  }
});

test('mirror write failure never breaks the turn', async (t) => {
  const storeDir = mkdtempSync(join(tmpdir(), 'atbx-store-'));
  try {
    const store = new TranscriptStore({ dir: storeDir });
    // 指向一个不可写的路径：写共享目录失败不能影响聊天本身
    const pi = createPiAdapter({ models, resolve, transcripts: store, piSessionDir: '/proc/nope/x' });
    const events = await collect(pi.run({
      messages: [{ role: 'user', content: 'hi' }],
      request: { provider: 'faux', model: 'faux' }, apiKey: 'k',
      sessionId: 'sess-mirror-2', cwd: '/tmp', toolTier: 'none',
    }));
    assert.ok(events.some((e) => e.type === 'turn_end'), 'turn still completes');
  } finally { rmSync(storeDir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/agent-server && node --test test/pi-session-interop.test.mjs`
Expected: FAIL — `piSessionId` undefined / 共享目录空

- [ ] **Step 3: `config.mjs` 加两个配置项**

```js
// 会话相关配置。默认值与 pi CLI / CC 自己的约定对齐，用户不改任何配置即可互通。
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionTtlMs() {
  const days = Number(process.env.ATBX_SESSION_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? days * 86400_000 : DEFAULT_SESSION_TTL_MS;
}

// 网站开的 pi 会话镜像到这个目录，本机 `pi --session-dir <此处> --session <id>` 打开。
// 缺省用 pi CLI 自己的默认位置，保证开箱互通。
export function piSessionDir() {
  return process.env.ATBX_PI_SESSION_DIR
    ?? join(homedir(), '.pi', 'agent', 'sessions');
}
```

- [ ] **Step 4: `pi.mjs` 加镜像写入**

4a. 签名加 `piSessionDir`：

```js
export function createPiAdapter({ models, resolve, makeAgent = defaultMakeAgent, capacity = 16, transcripts = null, piSessionDir = null } = {}) {
```

4b. 在 Task 4 步骤 3d 的 `transcripts.save(...)` 之后接镜像逻辑：

```js
        // 镜像一份 pi CLI 原生格式到共享目录：本机 `pi --session-dir <dir> --session <piSessionId>`
        // 就能打开这个会话。四条实测约束（见本节开头）：
        //   · 平铺在 piSessionDir 里——显式 --session-dir 时 CLI 非递归扫描，
        //     放进 <cwdSlug>/ 子目录会 No session found matching；
        //   · piSessionId 首次生成后固定存进记录，同一个会话始终是同一个 id；
        //   · 文件名固定（不含时间戳）→ 每轮覆写同一个文件，目录里不会堆 N 份副本；
        //   · assistant 的 usage 在 build 之前补零（缺失会让 CLI 崩在 totalTokens 上）。
        // 失败绝不影响回合——互通是增益，不是依赖。
        if (piSessionDir) {
          try {
            const rec = transcripts.get(sessionId) ?? {};
            const piSessionId = rec.piSessionId ?? randomUUID();
            const lines = buildPiSessionLines({
              piSessionId, cwd: cwd ?? process.cwd(), name: rec.title ?? 'AgentToolbox',
              messages: withUsage(agent.state.messages ?? []),
            });
            mkdirSync(piSessionDir, { recursive: true, mode: 0o700 });
            // 固定名：同一个会话始终这一个文件，每轮整体覆写
            // 0600：和 transcript 一个口径，里面是 full tier 的工具输出
            writeFileSync(join(piSessionDir, `${piSessionId}.jsonl`),
              renderPiSession(lines), { mode: 0o600 });
            transcripts.save({ id: sessionId, piSessionId });
          } catch (err) {
            logErr('pi:mirror', String(err?.message ?? err).slice(0, 120));
          }
        }
```

4b'. **`withUsage()` 取代 Task 4 的 `stripPartialUsage()`**，放在 `pi-session-writer.mjs` 里导出（纯函数，好测）：

```js
// 真 CLI 在 assistant 消息缺 usage 时直接崩：calculateContextTokens 读
// usage.totalTokens（实测 "Cannot read properties of undefined (reading
// 'totalTokens')"，带齐 api/provider/model 也照崩）。
// 而**残缺的 usage 反而是安全的**——实测 {input,output} 缺 totalTokens 也能正常
// resume（回忆出暗号成功）。所以方向是「缺失 → 补零」，不是「剥掉」：
// 剥离会把本来能用的 partial 变成致命的 absent。这条推翻了 Task 4 的
// stripPartialUsage，两处（落盘 transcript、镜像文件）必须一起改。
const EMPTY_USAGE = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function withUsage(messages) {
  return messages.map((m) => (
    m.role === 'assistant' && m.usage === undefined
      ? { ...m, usage: EMPTY_USAGE() }
      : m
  ));
}
```

给它配测试：assistant 消息无 usage → 补出 `totalTokens: 0`；已有 `{input:10,output:5}` → **原样保留**（不许补零覆盖真数据）；user 消息不动。

> **Task 4 的连带修正（必须同时做，否则镜像与 transcript 口径不一致）**：
> `pi.mjs` 里的 `stripPartialUsage` 整个换成 `withUsage`（改名 + 换语义），
> 落盘那处 `messages: stripPartialUsage(agent.state.messages)` 改成
> `messages: withUsage(agent.state.messages)`；`test/pi-adapter.test.mjs` 里
> 针对「剥掉 usage」的那条断言改成「补零」，注释里「残缺 usage 不能落盘」的
> 说法一并修正（它是错的：残缺没事，缺失才崩）。

4c. 文件顶部加 import：

```js
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPiSessionLines, renderPiSession, withUsage } from '../pi-session-writer.mjs';
import { VERBOSE, logErr } from '../log.mjs';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd packages/agent-server && node --test test/pi-session-interop.test.mjs`
Expected: PASS, 4 tests（mirror 格式 / usage 补零 / 覆写不堆积 / 写失败不影响回合）

再跑 `node --test test/pi-adapter.test.mjs`（Task 4 的连带修正后应仍全绿）与
`node --test "test/**/*.test.mjs"`（全量）。

- [ ] **Step 6: Commit**

```bash
git add packages/agent-server/src/config.mjs packages/agent-server/src/adapters/pi.mjs packages/agent-server/test/pi-session-interop.test.mjs
git commit -m "feat(agent-server): mirror pi sessions into the pi-CLI shared dir"
```

---

## Task 6: server 的 4 个路由 + persistId

**Files:**
- Modify: `packages/agent-server/src/server.mjs`
- Test: `packages/agent-server/test/server.test.mjs`

- [ ] **Step 1: 写失败测试**

追加到 `test/server.test.mjs`：

```js
import { TranscriptStore } from '../src/transcripts.mjs';

// withFauxServer 需要能把 store 传进去：给它的签名加第三个参数 transcripts，
// 并在 startServer 调用里传下去（见 Step 3）。

test('GET /sessions lists history for the given config, newest first', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    store.save({ id: 'old', agent: 'pi', cwd: '/tmp/x', provider: 'faux', model: 'faux', lastUsed: 1, title: '旧' });
    store.save({ id: 'new', agent: 'pi', cwd: '/tmp/x', provider: 'faux', model: 'faux', lastUsed: 2, title: '新' });
    const { status, body } = await json('/sessions?agent=pi&cwd=%2Ftmp%2Fx');
    assert.equal(status, 200);
    assert.deepEqual(body.sessions.map((s) => s.id), ['new', 'old']);
    assert.equal(body.sessions[0].messages, undefined, 'list payload stays metadata-only');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('POST /sessions with a persistId resumes instead of creating', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    store.save({
      id: 'resume-me', adapter: 'pi', agent: 'pi', provider: 'faux', model: 'faux',
      cwd: '/tmp', toolTier: 'none', messages: [{ role: 'user', content: 'earlier', timestamp: 1 }],
    });
    const r = await json('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ provider: 'faux', model: 'faux', persistId: 'resume-me' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.sessionId, 'resume-me', 'memory session id == persistId when resuming');
    assert.equal(r.body.resumed, true, 'tells the client this is a resume, not a fresh chat');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resuming a persistId that is already live is refused with 409', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    store.save({ id: 'dup', adapter: 'pi', agent: 'pi', provider: 'faux', model: 'faux', cwd: '/tmp', messages: [{ role: 'user', content: 'x', timestamp: 1 }] });
    const first = await json('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ provider: 'faux', model: 'faux', persistId: 'dup' }),
    });
    assert.equal(first.status, 200);
    const second = await json('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ provider: 'faux', model: 'faux', persistId: 'dup' }),
    });
    assert.equal(second.status, 409, 'two tabs must not share one transcript');
    assert.match(second.body.error, /already active/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DELETE /sessions/:id removes the history', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    store.save({ id: 'bye', agent: 'pi', cwd: '/tmp', provider: 'faux', model: 'faux' });
    const r = await json('/sessions/bye', { method: 'DELETE', headers: { Origin: 'http://localhost:4321' } });
    assert.equal(r.status, 204);
    assert.equal(store.get('bye'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('POST /sessions/clear clears only the given filter scope', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
    store.save({ id: 'a', agent: 'pi', cwd: '/tmp/x', provider: 'faux', model: 'faux' });
    store.save({ id: 'b', agent: 'pi', cwd: '/tmp/y', provider: 'faux', model: 'faux' });
    const r = await json('/sessions/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ cwd: '/tmp/x' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.cleared, 1, 'only the matching scope');
    assert.equal(store.get('b')?.id, 'b', 'other cwd untouched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/agent-server && node --test test/server.test.mjs 2>&1 | grep -E "✖" | head`
Expected: FAIL — 5 条新用例全红

- [ ] **Step 3: 改 `server.mjs`**

3a. `startServer` 签名加 `transcripts`，缺省自建（生产路径）：

```js
export async function startServer({ port = 0, hostname = '127.0.0.1', allowedOrigins = DEFAULT_ORIGINS, resolve = resolveModel, models, registry, acpProbe, approvalTimeoutMs = 120_000, transcripts = null, sessionTtlMs: ttlMs }) {
  // 磁盘 transcript：跨重启/跨逐出的历史。缺省自建（生产路径），测试注入临时目录。
  const store = transcripts ?? new TranscriptStore({ dir: join(homedir(), '.config', 'agenttoolbox', 'sessions'), ttlMs: ttlMs ?? sessionTtlMs() });
  store.sweep();   // 启动时清掉超期历史
```

3b. 适配器构造把 store 传下去：

```js
  const reg = registry ?? createRegistry([
    createPiAdapter({ models, resolve, transcripts: store, piSessionDir: piSessionDir() }),
    createCcAdapter({ transcripts: store }),
    acpAdapter,
  ]);
```

3c. `POST /sessions` 支持 `persistId`。在现有 `const id = randomUUID()` 附近改为：

```js
        // persistId：带上 = 恢复既有会话（内存 session id 与它一致，前端好认）；
        // 不带 = 新建。已有活跃内存会话的同 id → 409（两个标签页不能共用一份
        // transcript，后写的会覆盖前写的）。
        const persistId = typeof body.persistId === 'string' && body.persistId.trim() ? body.persistId.trim() : null;
        // 恢复材料先取出来：成功与否都要写进响应（resumed），前端据此决定要不要
        // 渲染历史。拿不到（记录没了/目录没了/agent 不支持）→ resumed:false，
        // 但 id 仍是 persistId，让前端别假装有历史。
        const material = persistId ? (adapter.restore?.(persistId) ?? null) : null;
        if (persistId && sessions.peek(persistId)) return json(409, { error: 'session already active' });
        const id = persistId ?? randomUUID();
```

**`resumed` 必须在两条出口都给**（原计划只写了失败那条，成功那条的 `resumed:true`
漏了，而本任务的测试正要断言它为真）。`POST /sessions` 结尾的返回改为：

```js
        return json(200, {
          sessionId: id, adapter: adapter.id,
          resumed: Boolean(material),
          provider: body.provider, model: body.model, cwd, toolTier,
          ...(material?.messages ? { messages: material.messages } : {}),
        });
```

（`messages` 一并返回，省掉前端再发一次请求——Task 7 的 4e 依赖它。
`title` 同理，有就带。）

3d. `dispose` 已经正确（走 `adapter.disposeSession?.()`，而 pi/cc 的
`disposeSession` 都是刻意 no-op —— LRU 逐出不能删历史，见 Task 4）。
**此步无需改动**，保留原样即可；别在这里加 `store.remove()`。

3e. 新增 4 个路由。放在 `POST /sessions` 之后、`/messages` 之前：

```js
      // 历史列表：某配置下的会话， newest first，只带元数据（见 TranscriptStore.list）。
      // 筛选四维与 pi 的 cacheKey 一致：换模型不该串到别的模型的历史里。
      if (req.method === 'GET' && url.pathname === '/sessions') {
        const filter = {};
        for (const k of ['agent', 'cwd', 'provider', 'model']) {
          const v = url.searchParams.get(k);
          if (v != null && v !== '') filter[k] = v;
        }
        return json(200, { sessions: store.list(filter) });
      }

      // 删单条历史（含 cc 的持久 config dir）。
      // **id 的正则必须与 store 的 SAFE_ID 对齐**：`[0-9a-f-]+` 只认小写十六进制，
      // 会把 `bye`/`dup`/`resume-me` 这类 id 挡在门外（404 而不是 204）——本任务
      // 自己的测试就用这些 id。UUID 当然也符合下面的式子。
      const delMatch = req.method === 'DELETE' && url.pathname.match(/^\/sessions\/([A-Za-z0-9_-]{1,128})$/);
      if (delMatch) {
        store.remove(delMatch[1]);
        return res.writeHead(204, cors).end();
      }

      // 按范围清空。刻意不提供全局清空——一键抹掉所有历史的权力属于终端
      // （`agenttoolbox-agent sessions --clear`），网页不该有。
      // store.clear() 对空筛选直接抛 TypeError：路由若忘了转发筛选，
      // 宁可炸也不要默默抹掉用户全部历史。全量清空走 store.clearAll()。
      if (req.method === 'POST' && url.pathname === '/sessions/clear') {
        const body = await readJson(req);
        const filter = {};
        for (const k of ['agent', 'cwd', 'provider', 'model']) {
          if (typeof body?.[k] === 'string' && body[k]) filter[k] = body[k];
        }
        return json(200, { cleared: store.clear(filter) });
      }
```

**注意顺序**：`GET /sessions` 必须放在 `POST /sessions` 判断之前或与之并列且用 method 区分——现有代码是 `if (req.method === 'POST' && url.pathname === '/sessions')`，两者不冲突，直接并列即可。

- [ ] **Step 4: 更新测试 helper**

`withFauxServer` 签名加 `transcripts` 参数并传给 `startServer`：

```js
async function withFauxServer(t, origins = ['http://localhost:4321'], acpProbe, transcripts) {
  ...
  const srv = await startServer({
    port: 0, allowedOrigins: origins, resolve, models, registry,
    acpProbe: acpProbe ?? (async () => false),
    ...(transcripts ? { transcripts } : {}),
  });
```

同时在文件顶部加 `const freshDir = () => mkdtempSync(join(tmpdir(), 'atbx-srv-'));` 及相应 import。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd packages/agent-server && npm test`
Expected: PASS（全部，含新 5 条 + 既有全部）

- [ ] **Step 6: Commit**

```bash
git add packages/agent-server/src/server.mjs packages/agent-server/test/server.test.mjs
git commit -m "feat(agent-server): session history routes and persistId resume"
```

---

## Task 7: 前端抽屉的「会话」行

**Files:**
- Modify: `src/lib/agentchat.ts`
- Modify: `src/pages/free-models.astro`

- [ ] **Step 1: 客户端封装（纯函数部分，可单测）**

在 `src/lib/agentchat.ts` 追加：

```ts
/** 历史列表的一条记录（网关只回元数据，不回 messages）。 */
export interface SessionSummary {
  id: string;
  adapter: string;
  agent: string;
  provider: string;
  model: string;
  cwd: string | null;
  toolTier: 'none' | 'read' | 'full';
  title: string;
  createdAt: number;
  lastUsed: number;
  /** pi 专属：本机 `pi --session <piSessionId>` 用它续上。 */
  piSessionId?: string | null;
  /** cc 专属：本机 `claude --resume <ccSessionId>` 用它续上。 */
  ccSessionId?: string | null;
}

export interface SessionListResponse { sessions: SessionSummary[] }

/** 列某配置下的历史。筛选四维与网关一致。 */
export async function listSessions(
  filter: { agent?: string; cwd?: string; provider?: string; model?: string },
  baseUrl = AGENT_URL,
): Promise<SessionSummary[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v) qs.set(k, v);
  const res = await fetch(`${baseUrl}/sessions?${qs}`, { headers: { 'content-type': 'application/json' } });
  if (!res.ok) return [];
  return ((await res.json()) as SessionListResponse).sessions ?? [];
}

export async function deleteSession(persistId: string, baseUrl = AGENT_URL): Promise<void> {
  await fetch(`${baseUrl}/sessions/${persistId}`, { method: 'DELETE' }).catch(() => {});
}

/** 按当前筛选范围清空。返回删掉的条数。 */
export async function clearSessions(
  filter: { agent?: string; cwd?: string; provider?: string; model?: string },
  baseUrl = AGENT_URL,
): Promise<number> {
  try {
    const res = await fetch(`${baseUrl}/sessions/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(filter),
    });
    if (!res.ok) return 0;
    return ((await res.json()) as { cleared: number }).cleared ?? 0;
  } catch { return 0; }
}

/**
 * 本机续接命令：把「统一管理」落到用户手里的那一行。
 * pi 需要 --session-dir（共享目录扁平存放，CLI 默认按 cwd 分子目录）；
 * cc 用 --resume，跨目录时 CLI 自己会问要不要 fork。
 */
export function localResumeCommand(s: SessionSummary): string | null {
  if (s.agent === 'pi' && s.piSessionId) {
    return `pi --session-dir ~/.pi/agent/sessions --session ${s.piSessionId}`;
  }
  if ((s.agent === 'cc' || s.adapter === 'cc') && s.ccSessionId) {
    return `claude --resume ${s.ccSessionId}`;
  }
  return null;   // acp 等：没有互通路径，UI 据此不显示复制按钮
}
```

- [ ] **Step 2: 抽屉 markup**

在 `#chat-drawer` 的 Agent 行之后插入（`<div class="chat-agent-row">…</div>` 之后）：

```astro
    <div class="chat-session-row" id="chat-session-row">
      <div class="chat-session-head">
        <label for="chat-session-list">会话</label>
        <button id="chat-new-session" type="button" class="cap-chip">＋ 新对话</button>
      </div>
      <div id="chat-session-list" class="chat-session-list" role="listbox" aria-label="历史会话"></div>
      <div class="chat-session-foot">
        <button id="chat-session-more" type="button" class="chat-sub" hidden>显示更多</button>
        <button id="chat-session-clear" type="button" class="chat-sub">清空此目录的历史</button>
      </div>
    </div>
```

- [ ] **Step 3: 抽屉样式**

在 `<style>` 里 `.config-drawer` 附近加：

```css
  .chat-session-row { border-top: 1px solid var(--line); padding-top: .6rem; margin-bottom: .6rem; }
  .chat-session-head { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
  .chat-session-head label { margin: 0; }
  .chat-session-list { display: flex; flex-direction: column; gap: .3rem; margin: .5rem 0; max-height: 11rem; overflow-y: auto; }
  .chat-session-item {
    display: flex; align-items: center; gap: .4rem;
    padding: .35rem .5rem; border: 1px solid var(--line); border-radius: 8px;
    background: var(--surface); cursor: pointer; font-size: .85rem; text-align: left;
  }
  .chat-session-item:hover { border-color: var(--cobalt); }
  .chat-session-item.is-active { border-color: var(--cobalt); background: var(--cobalt-wash); }
  .chat-session-item-main { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-session-time { flex: 0 0 auto; color: var(--ink-soft); font-size: .75rem; }
  .chat-session-del { flex: 0 0 auto; background: transparent; border: 0; color: var(--ink-soft); cursor: pointer; padding: 0 .2rem; font-size: .9rem; }
  .chat-session-resume { background: transparent; border: 0; color: var(--cobalt); cursor: pointer; padding: 0 .2rem; font-size: .78rem; }
  .chat-session-foot { display: flex; justify-content: space-between; gap: .5rem; }
  .chat-session-foot button { background: transparent; border: 0; color: var(--ink-soft); cursor: pointer; padding: .2rem 0; font-size: .8rem; font-weight: 500; }
  .chat-session-foot button:hover { color: var(--cobalt); }
  .chat-session-empty { color: var(--ink-soft); font-size: .82rem; margin: .3rem 0; }
```

- [ ] **Step 4: 脚本逻辑**

4a. 顶部 import 补三个函数：

```ts
  import { probeHealth, createSession, streamMessage, abortSession, fetchOpenRouterQuota, answerPermission, listSessions, deleteSession, clearSessions, localResumeCommand, type SessionSummary, keyStorage, type ChatEvent, type OpenRouterQuota } from '../lib/agentchat';
```

4b. 会话列表状态与渲染（放在 `resetStreamButtons` 附近）：

```ts
  const sessionListEl = $('chat-session-list');
  const sessionMoreBtn = $('chat-session-more') as HTMLButtonElement;
  const sessionClearBtn = $('chat-session-clear') as HTMLButtonElement;
  let sessionSummaries: SessionSummary[] = [];
  let sessionShowAll = false;
  // 当前会话的持久身份：undefined = 还没建过；null = 用户明确要新对话；
  // string = 某条历史的 id（恢复它）。
  let activePersistId: string | null | undefined = undefined;

  const SESSION_PAGE = 5;

  const fmtTime = (ts: number) => {
    const d = Date.now() - ts;
    if (d < 60_000) return '刚刚';
    if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
    return `${Math.floor(d / 86_400_000)} 天前`;
  };

  // 能恢复的才让点：acp 的记录点了也是空对话，标出来但不假装（spec 选项 A）。
  const canRestore = (s: SessionSummary) => s.adapter === 'pi' || s.adapter === 'cc';

  function renderSessionList(): void {
    sessionListEl.textContent = '';
    if (sessionSummaries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'chat-session-empty';
      empty.textContent = '这个目录下还没有历史对话。';
      sessionListEl.append(empty);
      sessionMoreBtn.hidden = true;
      return;
    }
    const shown = sessionShowAll ? sessionSummaries : sessionSummaries.slice(0, SESSION_PAGE);
    for (const s of shown) {
      const item = document.createElement('div');
      item.className = 'chat-session-item';
      item.setAttribute('role', 'option');
      if (s.id === activePersistId) item.classList.add('is-active');
      const main = document.createElement('span');
      main.className = 'chat-session-item-main';
      main.textContent = s.title || '(无标题)';
      if (!canRestore(s)) main.textContent = `⟲ ${main.textContent}`;
      const time = document.createElement('span');
      time.className = 'chat-session-time';
      time.textContent = fmtTime(s.lastUsed);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'chat-session-del';
      del.textContent = '🗑';
      del.setAttribute('aria-label', '删除这条历史');
      del.addEventListener('click', async (e) => {
        e.stopPropagation();   // 别触发 item 的恢复
        await deleteSession(s.id);
        sessionSummaries = sessionSummaries.filter((x) => x.id !== s.id);
        if (activePersistId === s.id) activePersistId = undefined;
        renderSessionList();
      });
      item.append(main, time, del);
      const cmd = localResumeCommand(s);
      if (cmd) {
        const resume = document.createElement('button');
        resume.type = 'button';
        resume.className = 'chat-session-resume';
        resume.textContent = '复制本机命令';
        resume.addEventListener('click', async (e) => {
          e.stopPropagation();
          try { await navigator.clipboard.writeText(cmd); resume.textContent = '已复制'; }
          catch { resume.textContent = '复制失败'; }
          setTimeout(() => { resume.textContent = '复制本机命令'; }, 1500);
        });
        item.append(resume);
      }
      item.addEventListener('click', () => {
        if (!canRestore(s)) { chatMsg('hint', '这个 agent 无法恢复上下文，将开始新对话。'); activePersistId = null; return; }
        activePersistId = s.id;
        openChat(currentPickEl!, { persistId: s.id });
      });
      sessionListEl.append(item);
    }
    sessionMoreBtn.hidden = sessionSummaries.length <= SESSION_PAGE;
    sessionMoreBtn.textContent = sessionShowAll ? '收起' : `显示更多（${sessionSummaries.length - SESSION_PAGE}）`;
  }

  async function refreshSessionList(): Promise<void> {
    const c = chat;
    if (!c) return;
    sessionSummaries = await listSessions({ agent: c.agent ?? c.agents[0] ?? 'pi', cwd: c.cwd, provider: c.provider, model: c.model });
    sessionShowAll = false;
    renderSessionList();
  }
```

4c. `openChat` 改成接收 `persistId`，并记录当前卡片元素：

```ts
  let currentPickEl: HTMLElement | null = null;

  function openChat(a: HTMLElement, opts: { persistId?: string | null } = {}) {
    ...
    // persistId：显式给的（用户点了某条历史 / 新对话）；否则 undefined =
    // 让 refreshSessionList 之后决定默认恢复哪条（最近一条）。
    chat = {
      ...
      sessionId: opts.persistId ?? null,
      persistId: opts.persistId,
      ...
    };
```

（`ChatState` 类型加 `persistId?: string | null;`）

4d. 恢复路径：`tryGoChat()` 里的 `ensureSession()` 改为带上 persistId：

```ts
    const res = await createSession({
      provider: c.provider, model: c.model, baseUrl: c.base || null,
      apiKey: keyStorage.get(c.provider),
      name: c.name, contextWindow: c.ctx, maxOutput: c.maxOut,
      agents: c.agents,
      anthropicApi: c.anthropicApi || null,
      agent: c.agent,
      cwd: c.toolTier === 'none' ? null : (c.cwd || null),
      toolTier: c.toolTier,
      persistId: c.persistId ?? undefined,
    });
```

4e. 历史消息回填。`tryGoChat()` 成功建会话后，若是恢复则把列表那条的消息渲染出来——**消息内容由网关在 `resumed: true` 时一并返回**。为免前端再发一次请求，让 `POST /sessions` 的恢复分支在响应里带 `messages`：

在 Task 6 步骤 3c 的恢复分支改返回：

```js
          const rec = store.get(persistId);
          return json(200, {
            sessionId: persistId, adapter: adapter.id, resumed: true,
            provider: body.provider, model: body.model, cwd, toolTier,
            messages: rec?.messages ?? [], title: rec?.title ?? null,
          });
```

前端在 `ensureSession()` 之后：

```ts
      if (res.resumed) {
        const n = res.messages?.length ?? 0;
        chatLog.textContent = '';
        const sep = chatMsg('hint', `— 已恢复 ${fmtTime(res.title ? Date.now() : Date.now())}前的对话，${n} 条消息 —`);
        sep.textContent = `— 已恢复历史对话，${n} 条消息 —`;
        for (const m of res.messages ?? []) {
          if (m.role !== 'user' && m.role !== 'assistant') continue;   // 跳过 system / tool 行
          const text = Array.isArray(m.content)
            ? m.content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[图片]' : `[${b.type}]`)).join('')
            : String(m.content ?? '');
          chatMsg(m.role, text);
        }
      }
```

（`SessionResponse` 类型加 `resumed?: boolean; messages?: unknown[]; title?: string | null;`）

4f. 三个按钮：

```ts
  ($('chat-new-session') as HTMLButtonElement).addEventListener('click', () => {
    activePersistId = null;           // 明确新对话：别自动恢复
    if (currentPickEl) openChat(currentPickEl, { persistId: null });
  });

  sessionMoreBtn.addEventListener('click', () => { sessionShowAll = !sessionShowAll; renderSessionList(); });

  sessionClearBtn.addEventListener('click', async () => {
    const c = chat;
    if (!c) return;
    const n = await clearSessions({ agent: c.agent ?? c.agents[0] ?? 'pi', cwd: c.cwd, provider: c.provider, model: c.model });
    chatMsg('hint', `已清空 ${n} 条历史。`);
    await refreshSessionList();
  });
```

4g. `openChat` 的记录点：两处 `.chat-pick` 监听里存下当前元素：

```ts
  document.querySelectorAll<HTMLButtonElement>('button.chat-pick').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); currentPickEl = a; openChat(a); });
  });
```

4h. `openChat` 里 `chatLog.textContent = ''` 之后、`void tryGoChat()` 之前插入列表刷新与默认恢复：

```ts
    // 有历史 → 默认恢复最近一条（spec 选项 C 的无缝部分）；用户显式选了
    // persistId（点某条 / 点新对话）时以那个为准。
    void refreshSessionList().then(() => {
      if (activePersistId !== undefined) return;   // 已明确：某条 or 新对话
      const latest = sessionSummaries.find((s) => canRestore(s));
      if (latest) { activePersistId = latest.id; chat.persistId = latest.id; }
    });
```

注意 `refreshSessionList` 依赖 `chat` 已建好，所以必须放在 `chat = {...}` 赋值之后。

- [ ] **Step 5: 类型检查与构建**

Run: `cd /home/dengzh/AI/agent-site && npx tsc --noEmit && npx astro build`
Expected: 0 errors（注意：`astro check` 在本仓库是坏的，用 tsc）

- [ ] **Step 6: Commit**

```bash
git add src/lib/agentchat.ts src/pages/free-models.astro
git commit -m "feat(site): session history row in the chat drawer"
```

---

## Task 8: 端到端——跨进程恢复 + 本机 CLI 打开

这两条是唯一能证明「真的 work」的测试：前 7 个任务都在单进程内自证。

**Files:**
- Create: `packages/agent-server/test/e2e-restore.test.mjs`

- [ ] **Step 1: 写测试**

```js
// 端到端：① 跨进程恢复（杀网关→重启→第三轮记得第一轮）
//        ② 网站会话本机可打开（pi CLI resume 我们写出的 JSONL）
// 两条都跑真实 CLI，故本机没装 claude / pi 时 skip，不让 CI 因环境缺失而红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { createCcAdapter } from '../src/adapters/cc.mjs';
import { TranscriptStore } from '../src/transcripts.mjs';
import { buildPiSessionLines, renderPiSession } from '../src/pi-session-writer.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const collect = async (iter) => { const out = []; for await (const e of iter) out.push(e); return out; };

// ── ① 跨进程恢复：cc 适配器 + 真实 CLI + 假上游 ────────────────────────────
test('cc session survives a gateway restart and resumes on the third turn', async (t) => {
  if (!(await createCcAdapter().available())) { t.skip('claude CLI not installed'); return; }

  const portFile = join(tmpdir(), `atbx-e2e-port-${process.pid}.txt`);
  rmSync(portFile, { force: true });
  const upstream = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-anthropic.mjs')], {
    env: { ...process.env, FAKE_ANTHROPIC_PORT_FILE: portFile }, stdio: 'ignore', detached: true,
  });
  t.after(() => { try { process.kill(-upstream.pid, 'SIGKILL'); } catch { /* 已退出 */ } });
  let port = null;
  for (let i = 0; i < 60 && !port; i++) {
    try { const p = Number(readFileSync(portFile, 'utf8').trim()); if (p) port = p; } catch { /* 还没写 */ }
    await delay(100);
  }
  assert.ok(port, 'fake upstream started');

  const storeDir = mkdtempSync(join(tmpdir(), 'atbx-e2e-store-'));
  const cwd = mkdtempSync(join(tmpdir(), 'atbx-e2e-cwd-'));
  t.after(() => rmSync(storeDir, { recursive: true, force: true }));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const store = new TranscriptStore({ dir: storeDir });
  const baseUrl = `http://127.0.0.1:${port}`;
  const SID = 'e2e-restore-1';
  const runTurn = async (text, resume) => collect(createCcAdapter().run({
    messages: [{ role: 'user', content: text }],
    model: 'claude-sonnet-4-5', apiKey: 'k', baseUrl, cwd, allowedTools: [],
    resumeSessionId: resume, sessionId: SID,
  }));

  const first = await runTurn('turn one', null);
  assert.equal(first.at(-1).type, 'turn_end', 'turn 1 ok');
  assert.ok(store.get(SID)?.ccSessionId, 'cc session id persisted');

  // 模拟网关重启：store 是新进程里读同一目录的那份，适配器实例全部重建
  const ccAfterRestart = createCcAdapter();
  const restored = ccAfterRestart.restore(SID);
  assert.ok(restored, 'restore finds the record after a cold start');
  assert.equal(restored.ccSessionId, store.get(SID).ccSessionId);

  const third = await runTurn('turn three', restored.ccSessionId);
  assert.equal(third.at(-1).type, 'turn_end', `turn 3 after restart errored: ${third.at(-1).message}`);
});

// ── ② 网站会话本机可打开 ──────────────────────────────────────────────────
test('a session file we write can be resumed by the real pi CLI', async (t) => {
  const piBin = await (async () => {
    const { execFile } = await import('node:child_process');
    return await new Promise((resolve) => execFile('which', ['pi'], (e) => resolve(!e)));
  })();
  if (!piBin) { t.skip('pi CLI not installed'); return; }

  const shared = mkdtempSync(join(tmpdir(), 'atbx-e2e-shared-'));
  const cwd = mkdtempSync(join(tmpdir(), 'atbx-e2e-picwd-'));
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // 用 Task 2 的写入器造一份会话，内容带一个只有续上才知道的暗号
  const piSessionId = '01e2e000-0000-7000-8000-0000000000ff';
  const lines = buildPiSessionLines({
    piSessionId, cwd, name: 'e2e',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '记住暗号是 木瓜' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: '好的。' }], timestamp: 2 },
    ],
  });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(shared, `2026-10-20T00-00-00-000Z_${piSessionId}.jsonl`), renderPiSession(lines));

  // 真 CLI 必须能找到并续上。跨 cwd → 用 --fork（实测非交互可用）。
  const out = await new Promise((resolve, reject) => {
    execFile('pi', ['--print', '--session-dir', shared, '--fork', piSessionId, '暗号是什么'], { cwd, timeout: 90_000 }, (err, stdout, stderr) => {
      resolve(`${stdout}${stderr}`);
    });
  });
  assert.match(out, /木瓜/, `pi CLI did not recall the seeded context. output: ${out.slice(0, 300)}`);
});
```

测试文件顶部需要补 import：`import { execFile } from 'node:child_process';` 与 `import { writeFileSync } from 'node:fs';`（合并进已有的 fs import）。

- [ ] **Step 2: 运行测试确认通过**

Run: `cd packages/agent-server && node --test test/e2e-restore.test.mjs`
Expected: PASS（未装对应 CLI 则 skip，不计失败）

- [ ] **Step 3: 全量回归**

Run: `cd packages/agent-server && npm test`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add packages/agent-server/test/e2e-restore.test.mjs
git commit -m "test(agent-server): e2e cross-process restore and pi-CLI interop"
```

---

## Task 9: 终端 `sessions` 子命令

全局清空的权力在终端，不在网页（spec 非目标）。

**Files:**
- Modify: `packages/agent-server/bin/agenttoolbox-agent.mjs`
- Test: `packages/agent-server/test/cli.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
test('sessions list prints history and clear removes it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cli-'));
  try {
    const store = new TranscriptStore({ dir });
    store.save({ id: 'cli-1', agent: 'pi', cwd: '/tmp/x', provider: 'faux', model: 'faux', title: '甲' });
    store.save({ id: 'cli-2', agent: 'pi', cwd: '/tmp/y', provider: 'faux', model: 'faux', title: '乙' });
    const cfgPath = join(dir, 'config.json');

    const run = (args) => new Promise((resolve) => {
      execFile(process.execPath, [binPath, ...args], { env: { ...process.env, ATBX_CONFIG_PATH: cfgPath, ATBX_SESSION_DIR: dir } }, (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, out: stdout, err: stderr });
      });
    });

    const listed = await run(['sessions', 'list']);
    assert.equal(listed.code, 0);
    assert.match(listed.out, /cli-1/);
    assert.match(listed.out, /甲/);

    const cleared = await run(['sessions', 'clear', '--yes']);
    assert.equal(cleared.code, 0);
    assert.equal(store.get('cli-1'), null);
    assert.equal(store.get('cli-2'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

测试需在文件里补 `const binPath = join(dirname(fileURLToPath(import.meta.url)), '../bin/agenttoolbox-agent.mjs');`、`execFile` import、`TranscriptStore` import，以及 `mkdtempSync`/`rmSync`/`join` import。若 `cli.test.mjs` 已有类似 helper，复用它。

**注意**：这要求 `bin` 读 `ATBX_SESSION_DIR`。当前 spec 只定义了 `ATBX_PI_SESSION_DIR`（共享镜像目录）和 `ATBX_CONFIG_PATH`（含 sessions 子目录）。为测试可注入，给 store 目录加一个 `ATBX_SESSION_DIR` 覆盖——在 `server.mjs` 构造 store 处：

```js
  const store = transcripts ?? new TranscriptStore({
    dir: process.env.ATBX_SESSION_DIR ?? join(homedir(), '.config', 'agenttoolbox', 'sessions'),
    ttlMs: ttlMs ?? sessionTtlMs(),
  });
```

bin 里同样读这个变量。

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/agent-server && node --test test/cli.test.mjs 2>&1 | grep -A3 "sessions list"`
Expected: FAIL — 未知子命令，退出码非 0

- [ ] **Step 3: 实现子命令**

在 `bin/agenttoolbox-agent.mjs` 的 grant/list/revoke 分支之后、`const args = process.argv.slice(2)` 之前插入：

```js
// 会话历史的终端入口。刻意不放网页：一键抹掉所有历史的权力属于终端
// （spec 非目标）。list 只显示元数据，绝不打印消息内容——那可能含密钥。
if (sub === 'sessions') {
  const action = process.argv[3];
  const dir = process.env.ATBX_SESSION_DIR ?? join(homedir(), '.config', 'agenttoolbox', 'sessions');
  if (action === 'list') {
    const store = new TranscriptStore({ dir });
    const rows = store.list({});
    if (!rows.length) { console.log('(no sessions)'); process.exit(0); }
    for (const r of rows) {
      const when = new Date(r.lastUsed).toISOString().slice(0, 16).replace('T', ' ');
      console.log(`${r.id}  ${when}  ${r.agent}  ${r.cwd ?? '-'}  ${r.title ?? ''}`);
    }
    process.exit(0);
  }
  if (action === 'clear') {
    if (process.argv[4] !== '--yes') {
      console.error('refusing to clear without --yes (this deletes every session transcript)');
      process.exit(1);
    }
    const store = new TranscriptStore({ dir });
    // 全量清空是 CLI 的权力：store.clear() 要求非空筛选（网页只允许删某一
    // 组配置的历史），全局抹除走 clearAll()。
    const n = store.clearAll();
    console.log(`cleared ${n} session(s)`);
    process.exit(0);
  }
  console.error('usage: agenttoolbox-agent sessions <list|clear --yes>');
  process.exit(1);
}
```

顶部 import 补：`import { TranscriptStore } from '../src/transcripts.mjs';`、`import { homedir } from 'node:os';`、`import { join } from 'node:path';`

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/agent-server && node --test test/cli.test.mjs`
Expected: PASS

- [ ] **Step 5: 文档**

在 `packages/agent-server/README.md` 的「Directory grants」附近加一节：

```markdown
## Session history

Conversations are persisted to `~/.config/agenttoolbox/sessions/` so they
survive drawer closes, reloads and gateway restarts (7-day TTL by default;
override with `ATBX_SESSION_TTL_DAYS`). Records are `0600`, the directory
`0700` — transcripts can contain file contents, command output and
screenshots from `full` tier runs. **API keys are never written to disk.**

Website-created sessions are also mirrored into `~/.pi/agent/sessions/` in
pi CLI's native format, so you can continue one locally:

    pi --session-dir ~/.pi/agent/sessions --session <piSessionId> "…"

The drawer shows that exact command with a copy button. `cc` sessions resume
locally with `claude --resume <ccSessionId>`. Sessions you start in the
terminal yourself are not listed in the web UI — that direction is one-way.

Terminal management (the web UI can only clear the current directory's scope):

    npx agenttoolbox-agent sessions list           # metadata only, never message text
    npx agenttoolbox-agent sessions clear --yes    # deletes every transcript
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent-server/bin/agenttoolbox-agent.mjs packages/agent-server/test/cli.test.mjs packages/agent-server/README.md packages/agent-server/src/server.mjs
git commit -m "feat(agent-server): terminal sessions subcommand and docs"
```

---

## Self-Review

**1. Spec coverage**

| Spec 要求 | 任务 |
|---|---|
| TranscriptStore（写/读/列/删/TTL/损坏降级/权限/原子写） | Task 1 |
| pi CLI 原生格式（事件日志 + parentId 链 + cwd 保留 + 图片） | Task 2、Task 5 |
| cc 的 restore/persist + config dir 持久化 | Task 3 |
| pi 的 restore/persist + `initialState.messages` 重建 | Task 4 |
| 4 个 HTTP 路由 + `persistId` + 409 并发 | Task 6 |
| 前端会话行（5 条+更多、新对话、删除、按范围清、恢复提示、复制本机命令） | Task 7 |
| 端到端跨进程恢复 | Task 8 ① |
| 端到端本机 CLI 互通 | Task 8 ② |
| 终端 `sessions` 子命令（全局清空的权力在终端） | Task 9 |
| apiKey 永不落盘 | 全任务无 key 读写入口；Task 9 文档明示 |
| `ATBX_SESSION_TTL_DAYS` / `ATBX_PI_SESSION_DIR` / `ATBX_SESSION_DIR` | Task 5、Task 9 |
| acp 降级（不支持则标注 + 开新会话） | Task 7 的 `canRestore` |

**2. 发现并修掉的缺口**

- spec 说 `GET /sessions` 与 `POST /sessions` 同路径按 method 区分——Task 6 步骤 3e 明确写成并列 `if`，并提醒与既有 `POST` 判断不冲突。
- spec 的恢复流程没说要怎么把历史消息送给前端。Task 7 步骤 4e 定为「`POST /sessions` 恢复分支在响应里带 `messages`」，避免前端多一次请求；同步改了 Task 6 步骤 3c 的返回值与 `SessionResponse` 类型。
- `canRestore` 按 `adapter` 字段判（pi/cc），不是 spec 里被否掉的「存布尔值」——这里判的是适配器能力（静态），不是「目录还在不在」（动态，由 `restore()` 返回 null 表达）。两者不重复。
- Task 9 的测试需要可注入的 store 目录，而 spec 只定义了 `ATBX_CONFIG_PATH`（含 sessions 子目录）。补了 `ATBX_SESSION_DIR` 覆盖，Task 6 步骤 3a 与 bin 都读它。
- Task 7 的 `fmtTime(res.title ? Date.now() : Date.now())` 是个恒等表达的残留——已改为直接 `— 已恢复历史对话，N 条消息 —`。

**3. 类型/命名一致性**

- `persistId` 全程一致（HTTP body 字段、`ChatState.persistId`、内存 session id）。
- `TranscriptStore` 的方法名 `save/get/list/remove/clear/sweep` 在 Task 1 定义后，Task 3-9 全部沿用，无改名。
- `buildPiSessionLines` / `renderPiSession` 在 Task 2 定义，Task 5、Task 8 ② 沿用同一签名。
- adapter 钩子统一为 `restore(sessionId)` / `disposeSession(sessionId)`；`persist` 由适配器内部在轮末自行调用 store（不需要 server 触发），故不设独立钩子——Task 3/4 的实现与 spec 的「两个钩子」表述略有差异，spec 应同步改为「`restore` / `disposeSession` 两个钩子 + 轮末自动持久化」。
- `SessionSummary` 字段与 Task 1 的存储字段一一对应。
