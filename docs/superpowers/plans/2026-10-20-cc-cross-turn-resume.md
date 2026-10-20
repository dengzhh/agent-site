# cc 跨 turn resume 修复 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix "cc chat 第 2 条消息立即报错" — the cc adapter passes `--resume <old-id>` to a CLI whose isolated `CLAUDE_CONFIG_DIR` was created fresh this turn and deleted at the end of the last one, so the transcript can never be found.

**Root cause (already proven, see §Evidence):** `cc.mjs` creates a new `CLAUDE_CONFIG_DIR` per `run()` and `rmSync`s it in the `finally`. `server.mjs` stores the `session_id` from each turn's `result` line and passes it back as `resumeSessionId` on the next turn. `claude --resume <id>` looks the transcript up **inside `CLAUDE_CONFIG_DIR`** (`<dir>/projects/<slug>/<id>.jsonl`). Because the dir is brand new and empty, the CLI reports `No conversation found with session ID: …` and the turn dies immediately. This is exactly the symptom the user hit: they picked a tool tier, the agent appeared to "do real work" on turn 1, and turn 2 errored out.

**Architecture:** Make the isolated config dir's lifetime match the thing that actually needs it — the *session*, not the turn. The adapter gains a tiny dir-scoped cache keyed by the caller-supplied `sessionId` (which `server.mjs` already passes in for pi's cross-turn Agent cache), so:
- turn 1: create dir, spawn, write transcript, **keep** the dir;
- turn 2: same `sessionId` → same dir → `--resume` finds the transcript → context preserved;
- session ends / is evicted / config changes → caller calls `dispose()` (or the dir ages out) → dir removed.

No change to `--resume` semantics, no change to the event contract, no change to server routes.

**Tech Stack:** Node test runner (`node --test`), existing fixtures. New fixture `fake-anthropic.mjs` (local Anthropic-compatible SSE upstream) so tests can drive the *real* `claude` CLI end-to-end without credentials or network.

---

## Evidence (gathered 2026-10-20, before any fix)

Real CLI `claude 2.1.302`, isolated `CLAUDE_CONFIG_DIR`, dead `ANTHROPIC_BASE_URL` so no real API call happens:

| 实验 | 结果 |
|---|---|
| `--resume <random-uuid>` + 全新 config dir | `No conversation found with session ID: …` → `is_error:true` |
| 同一 config dir 跑两轮，第 2 轮 `--resume <第 1 轮的 id>` | 两轮 `is_error:false`，第 2 轮 `session_id` 与第 1 轮相同 |
| 读该 config dir 的 transcript | 37 行，`user "turn 1 hi"` → `assistant` → `user "turn 2 hi"` → `assistant`（**上下文确实累积**） |
| `node test/zz-repro.mjs`（适配器级，假上游） | turn 1 `delta,turn_end`；turn 2（带 `resumeSessionId`）`error` |

复刻路径：`packages/agent-server/test/zz-repro.mjs`（一次性脚本，实现完成后删除）。

---

## File Structure

- **Modify** `packages/agent-server/src/adapters/cc.mjs` — per-session config dir cache + `disposeSession(id)`; keep the existing `liveConfigDirs` global sweep for crash safety.
- **Modify** `packages/agent-server/src/server.mjs` — call `adapter.disposeSession?.(id)` when a session is dropped (TTL/capacity eviction) so dirs don't leak.
- **Create** `packages/agent-server/test/fixtures/fake-anthropic.mjs` — local `/v1/messages` SSE upstream (already written).
- **Modify** `packages/agent-server/test/cc-adapter.test.mjs` — the failing test + regression assertions.
- **Modify** `packages/agent-server/test/fixtures/README.md` — fixture row + update the "已知问题" section that documents this bug.

---

## Task 1: Failing test — second turn resumes instead of erroring

**Files:**
- Test: `packages/agent-server/test/cc-adapter.test.mjs`

- [ ] **Step 1: Add the real-CLI end-to-end test**

This test spawns the **real** `claude` CLI, so it is the only one in the suite that needs it. Guard it: skip when the binary is missing (CI without the CLI shouldn't go red).

```js
// 跨 turn resume 回归（用户实见症状）：第 2 条消息不得因 "--resume 打到全新
// 空 config dir" 而立即 error。真实 CLI 2.1.302 实测报
// "No conversation found with session ID: …"。
// 隔离 CLAUDE_CONFIG_DIR 必须跟随 session 生命周期，而不是每轮 turn。
test('cc adapter keeps the isolated config dir across turns so --resume works', async (t) => {
  const realCli = await createCcAdapter().available();
  if (!realCli) { t.skip('claude CLI not installed'); return; }

  const { baseUrl, close } = await startFakeAnthropic();
  t.after(close);

  const cc = createCcAdapter();
  const cwd = mkdtempSync(join(tmpdir(), 'atbx-cc-resume-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const run = (resumeSessionId) => collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'claude-sonnet-4-5', apiKey: 'k', baseUrl, cwd, allowedTools: [],
    resumeSessionId, sessionId: 'sess-resume-1',
  }));

  const first = await withTimeout(run(null), 60000, 'first turn');
  const firstSid = first.find((e) => e.sessionId)?.sessionId;
  assert.ok(firstSid, 'first turn reports a session id');
  assert.equal(first.at(-1).type, 'turn_end');

  const second = await withTimeout(run(firstSid), 60000, 'second turn');
  assert.equal(second.at(-1).type, 'turn_end', `second turn errored: ${second.at(-1).message}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cc-adapter.test.mjs 2>&1 | grep -A5 'resume'`
Expected: FAIL — `second turn errored: Claude Code error`.

- [ ] **Step 3: Add the fake upstream helper to the test file**

```js
import { spawn } from 'node:child_process';
// 本地假 Anthropic 上游：让真实 CLI 能端到端跑完一轮（无需 key、不外网）。
// 端口由夹具写文件上报，避免探测固定端口。
const startFakeAnthropic = async () => {
  const portFile = join(tmpdir(), `atbx-fake-upstream-${process.pid}-${Date.now()}.port`);
  const child = spawn(process.execPath, [join(import.meta.dirname, 'fixtures/fake-anthropic.mjs')], {
    env: { ...process.env, FAKE_ANTHROPIC_PORT_FILE: portFile }, stdio: 'ignore', detached: true,
  });
  const port = await (async () => {
    for (let i = 0; i < 50; i++) {
      try { const p = Number(readFileSync(portFile, 'utf8').trim()); if (p) return p; } catch { /* 还没写 */ }
      await delay(100);
    }
    throw new Error('fake upstream never reported a port');
  })();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ } rmSync(portFile, { force: true }); } };
};
```

- [ ] **Step 4: Commit the failing test**

```bash
git add packages/agent-server/test/cc-adapter.test.mjs packages/agent-server/test/fixtures/fake-anthropic.mjs
git commit -m "test(agent-server): failing regression — cc second turn resume"
```

---

## Task 2: Tie the isolated config dir to the session, not the turn

**Files:**
- Modify: `packages/agent-server/src/adapters/cc.mjs`

- [ ] **Step 1: Replace the per-run dir with a per-session dir cache**

```js
// 隔离配置目录按 **session** 缓存（不是每轮 turn）：claude --resume <id> 只在
// CLAUDE_CONFIG_DIR 里找 transcript（<dir>/projects/<slug>/<id>.jsonl）。每轮新建
// 并删除目录，resume 必败——实测报 "No conversation found with session ID"，
// 用户看到的就是「第 2 条消息立即报错」。
// server.mjs 早已为 pi 的跨轮 Agent 缓存传入同一个 sessionId，这里复用它做键。
const configDirs = new Map();   // sessionId → { dir, lastUsed }
const CONFIG_DIR_TTL_MS = 30 * 60_000;   // 与 SessionStore TTL 对齐

function configDirFor(sessionId) {
  const now = Date.now();
  for (const [id, e] of configDirs) if (now - e.lastUsed > CONFIG_DIR_TTL_MS) dropConfigDir(id);
  if (sessionId) {
    const hit = configDirs.get(sessionId);
    if (hit) { hit.lastUsed = now; return hit.dir; }
  }
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-'));
  if (sessionId) configDirs.set(sessionId, { dir, lastUsed: now });
  return dir;
}

function dropConfigDir(id) {
  const e = configDirs.get(id);
  if (!e) return;
  configDirs.delete(id);
  try { rmSync(e.dir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
}
```

- [ ] **Step 2: Use it in `run()` and only clean up when we own the dir**

In `run()`: `const owned = !(sessionId && configDirs.has(sessionId));` … `const configDir = configDirFor(sessionId);`
In the `finally`: `if (owned) rmSync(configDir, …)` — i.e. a cached dir survives the turn.
Expose on the adapter object:

```js
// 会话终结（TTL/容量逐出、客户端显式关闭）时由 server 调用，回收隔离目录。
disposeSession(id) { if (id) dropConfigDir(id); },
```

- [ ] **Step 3: Keep the crash-safety sweep**

`liveConfigDirs` must now also track **cached** dirs (they outlive the turn), so `sweepSync` on `process.on('exit')` / SIGTERM still reclaims them. Add the dir to `liveConfigDirs` when cached and delete it in `dropConfigDir`.

- [ ] **Step 4: Wire server eviction**

In `server.mjs`, `record.dispose` currently denies pending perms. Extend it:

```js
record.dispose = () => { denyPendingPerms(record); adapter.disposeSession?.(id); };
```

- [ ] **Step 5: Run tests**

Run: `node --test test/cc-adapter.test.mjs`
Expected: PASS including the new resume test. Then the whole package:
`npm test` → all green.

- [ ] **Step 6: Delete the one-off repro**

`rm packages/agent-server/test/zz-repro.mjs` (it was a scratch reproduction; the real assertion now lives in the suite).

- [ ] **Step 7: Commit**

```bash
git add packages/agent-server/src/adapters/cc.mjs packages/agent-server/src/server.mjs
git commit -m "fix(agent-server): tie cc isolated config dir to session so --resume works"
```

---

## Task 3: Surface the CLI's own error detail

**Files:**
- Modify: `packages/agent-server/src/adapters/cc-stream.mjs`, `packages/agent-server/test/cc-stream.test.mjs`

The user's other complaint ("报错但看不出报了什么") comes from `parseCcLine` returning the bare string `'Claude Code error'` when the `result` line has no `result` field, while the real reason sits in the line's `errors[]` array (proven: `"errors":["No conversation found with session ID: …"]`).

- [ ] **Step 1: Failing test**

```js
test('parseCcLine surfaces the errors[] detail on an error result', () => {
  const line = JSON.stringify({ type: 'result', is_error: true, subtype: 'error_during_execution',
    result: '', errors: ['No conversation found with session ID: abc'], session_id: 's1' });
  assert.match(parseCcLine(line).message, /No conversation found with session ID: abc/);
});
```

- [ ] **Step 2: Implement**

In the `obj.type === 'result'` / `is_error` branch, prefer `errors[0]` when `result` is empty:

```js
const detail = String(obj.result ?? '').trim() ||
  (Array.isArray(obj.errors) && obj.errors.length ? String(obj.errors[0]) : '') ||
  'Claude Code error';
```

- [ ] **Step 3: Run + commit**

```bash
node --test test/cc-stream.test.mjs
git commit -am "fix(agent-server): surface CLI error detail instead of a bare message"
```

---

## Task 4: Update the fixture README (the bug is now fixed)

**Files:**
- Modify: `packages/agent-server/test/fixtures/README.md`

- [ ] **Step 1:** Replace the "已知问题" paragraph about the cc resume bug with a short note that it is fixed (2026-10-20) and how (per-session config dir + `disposeSession`). Add `fake-anthropic.mjs` to the fixture table.

- [ ] **Step 2: Commit**

```bash
git commit -am "docs(agent-server): record the cc resume fix and the fake upstream fixture"
```

---

## Self-Review

- Root cause proven before any code change (§Evidence) — the Iron Law is satisfied.
- Task 1 is a genuine failing test that reproduces the user's exact symptom.
- Task 2 fixes the *lifetime* mismatch (dir vs session), not the symptom.
- Task 3 addresses the user's secondary complaint with the actual data the CLI already sends.
- No route/contract changes; the SSE surface is untouched.
- Risk: config dirs now live up to 30 min. Mitigated by `disposeSession` on eviction, TTL sweep, and the existing exit/SIGTERM sweep.
