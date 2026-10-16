# Multi-Agent ACP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让网站 Chat 抽屉可切换多种 coding agent（hermes / openclaw / opencode / codex / dsh 走新增的 ACP 适配器；pi / claude-code 复用现有适配器），并在界面顶部提供 Agent 下拉。

**Architecture:** 在已建成的适配器架构（`registry` + `pi` / `cc`）上新增一个 `acp.mjs`，内部维护 agent→命令定义表，用官方 `@agentclientprotocol/sdk` 通过 stdio JSON-RPC 驱动各 agent，把 ACP 通知映射为既有 `AgentEvent` 契约（`delta`/`turn_end`/`error`/`done`，新增 `thinking`）。`/health.agents` 扩展为带名称与可用性；`/sessions` 接受显式 `agent` 字段。

**Tech Stack:** Node ≥22（`node:child_process` + `node:stream`）、`@agentclientprotocol/sdk@^1.7.0`、既有 pi-ai/pi-agent-core、vitest（站点）/ node:test（网关）。

**Spec:** `docs/superpowers/specs/2026-10-07-multi-agent-acp-design.md`

**已实测事实（2026-10-07，直接依赖，勿再猜）：**
- `ndJsonStream(output, input)`：**output = 我们写→agent 读（WritableStream）；input = agent 写→我们读（ReadableStream）**。参数写反会得到 `TypeError: input.getReader is not a function`
- 需要 Web Streams：`Readable.toWeb(child.stdout)` / `Writable.toWeb(child.stdin)`
- `new acp.ClientSideConnection((agent) => clientImpl, stream)`，之后 `conn.initialize({protocolVersion:1, clientCapabilities:{}})` / `conn.newSession({cwd, mcpServers:[]})` / `conn.prompt({sessionId, prompt:[{type:'text',text}]})`
- client 需实现 `sessionUpdate(params)`（流式）、`requestPermission(req)`、`readTextFile`/`writeTextFile`（可抛错）
- `sessionUpdate` 的 params 里 `params.update.sessionUpdate` 取值：`agent_message_chunk`（正文，取 `update.content.text`）、`agent_thought_chunk`（思维链）、`usage_update`（用量）
- `prompt` 返回 `{stopReason}`，正常结束为 `'end_turn'`
- **hermes 已端到端跑通**：`initialize → session/new → prompt → 流式 PONG → end_turn`，`TEXT: "PONG"`
- hermes 会向 stderr 输出大量插件/警告日志（实测），必须丢弃或转日志，绝不能进事件流

---

### Task 1: ACP 适配器骨架与 agent 定义表

**Files:**
- Create: `packages/agent-server/src/adapters/acp-agents.mjs`
- Test: `packages/agent-server/test/acp-agents.test.mjs`
- Modify: `packages/agent-server/package.json`（新增依赖 `@agentclientprotocol/sdk`）

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACP_AGENTS, getAgentDef, listAgentIds } from '../src/adapters/acp-agents.mjs';

test('agent table covers the five ACP agents', () => {
  assert.deepEqual(listAgentIds().sort(), ['codex', 'dsh', 'hermes', 'openclaw', 'opencode']);
});

test('each definition has a command and an isolation env factory', () => {
  for (const id of listAgentIds()) {
    const d = getAgentDef(id);
    assert.equal(typeof d.cmd, 'string', `${id}: cmd`);
    assert.ok(Array.isArray(d.args), `${id}: args`);
    assert.equal(typeof d.isolateEnv, 'function', `${id}: isolateEnv`);
    assert.equal(typeof d.name, 'string', `${id}: name`);
  }
});

test('isolateEnv points config at the given dir, never the user home', () => {
  const dir = '/tmp/atbx-test-home';
  for (const id of listAgentIds()) {
    const env = getAgentDef(id).isolateEnv(dir);
    const vals = Object.values(env);
    assert.ok(vals.some((v) => v === dir), `${id}: one env var must equal the given dir`);
    for (const v of vals) assert.doesNotMatch(String(v), /\/\.(hermes|openclaw|codex|dsh|config)/);
  }
});

test('unknown agent id returns undefined', () => {
  assert.equal(getAgentDef('nope'), undefined);
});

test('codex and dsh use npx so they need no global install', () => {
  assert.equal(getAgentDef('codex').cmd, 'npx');
  assert.equal(getAgentDef('dsh').cmd, 'npx');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/agent-server && npm test`
Expected: FAIL — `Cannot find module '../src/adapters/acp-agents.mjs'`

- [ ] **Step 3: 安装依赖**

```bash
cd packages/agent-server && npm install @agentclientprotocol/sdk@^1.7.0
```
（注意：这是 workspace 包，实际会更新根 `package-lock.json`。确认 `package.json` 的 `dependencies` 里出现该条目。）

- [ ] **Step 4: 实现**

```javascript
// ACP agent 定义表：每个 agent 的启动命令 + 配置隔离环境变量。
// 隔离变量名来自各 agent 的官方文档；实现时须逐个实测确认（见 spec 风险节）。
// 未实测通过的 agent 不应出现在 UI —— available() 探测失败即自动隐藏。
export const ACP_AGENTS = {
  hermes: {
    name: 'Hermes',
    cmd: 'hermes',
    args: ['acp'],
    isolateEnv: (dir) => ({ HERMES_HOME: dir }),
  },
  openclaw: {
    name: 'OpenClaw',
    cmd: 'openclaw',
    args: ['acp'],
    isolateEnv: (dir) => ({ OPENCLAW_HOME: dir }),
  },
  opencode: {
    name: 'OpenCode',
    cmd: 'opencode',
    args: ['acp'],
    isolateEnv: (dir) => ({ OPENCODE_CONFIG_DIR: dir, OPENCODE_DISABLE_CLAUDE_CODE: '1' }),
  },
  codex: {
    // Zed 官方适配器：把 Codex 包装成 ACP 服务端，无需全局安装 codex
    name: 'Codex',
    cmd: 'npx',
    args: ['-y', '@zed-industries/codex-acp'],
    isolateEnv: (dir) => ({ CODEX_HOME: dir }),
  },
  dsh: {
    // DeepSeek Harness 的一等公民 ACP profile
    name: 'DeepSeek Harness',
    cmd: 'npx',
    args: ['-y', '@deepseek-ai/dsh', '--profile', 'acp'],
    isolateEnv: (dir) => ({ DSH_HOME: dir }),
  },
};

export function getAgentDef(id) {
  return ACP_AGENTS[id];
}

export function listAgentIds() {
  return Object.keys(ACP_AGENTS);
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test`
Expected: 5 new passing（总数 = 60 + 5 = 65）

- [ ] **Step 6: 提交**

```bash
git add packages/agent-server/src/adapters/acp-agents.mjs packages/agent-server/test/acp-agents.test.mjs packages/agent-server/package.json package-lock.json
git commit -m "feat(agent-server): ACP agent definition table"
```
(End commit message with trailer: `Co-Authored-By: Claude Code <noreply@anthropic.com>`)

---

### Task 2: ACP 通知 → AgentEvent 映射（纯函数）

**Files:**
- Create: `packages/agent-server/src/adapters/acp-stream.mjs`
- Test: `packages/agent-server/test/acp-stream.test.mjs`

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSessionUpdate } from '../src/adapters/acp-stream.mjs';

test('agent_message_chunk becomes a delta', () => {
  const p = { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } } };
  assert.deepEqual(mapSessionUpdate(p), [{ type: 'delta', text: 'PONG' }]);
});

test('agent_thought_chunk becomes a thinking event', () => {
  const p = { sessionId: 's', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } };
  assert.deepEqual(mapSessionUpdate(p), [{ type: 'thinking', text: 'hmm' }]);
});

test('usage_update is captured, not streamed as text', () => {
  const p = { sessionId: 's', update: { sessionUpdate: 'usage_update', usage: { inputTokens: 10, outputTokens: 2 } } };
  const out = mapSessionUpdate(p);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'usage');
  assert.deepEqual(out[0].usage, { inputTokens: 10, outputTokens: 2 });
});

test('tool_call updates are surfaced as activity, not text', () => {
  const p = { sessionId: 's', update: { sessionUpdate: 'tool_call', title: 'Read file' } };
  const out = mapSessionUpdate(p);
  assert.equal(out[0].type, 'activity');
  assert.equal(out[0].title, 'Read file');
});

test('unknown update kinds yield no events', () => {
  assert.deepEqual(mapSessionUpdate({ update: { sessionUpdate: 'plan' } }), []);
  assert.deepEqual(mapSessionUpdate({}), []);
  assert.deepEqual(mapSessionUpdate(null), []);
});

test('empty or missing text is skipped', () => {
  assert.deepEqual(mapSessionUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { text: '' } } }), []);
  assert.deepEqual(mapSessionUpdate({ update: { sessionUpdate: 'agent_message_chunk' } }), []);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

```javascript
// ACP `session/update` 通知 → 网关事件。纯函数，便于单测。
// 未识别的 update 类型一律忽略（协议会演进；未知类型不该打断会话）。
export function mapSessionUpdate(params) {
  const u = params?.update;
  if (!u || typeof u !== 'object') return [];
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = u.content?.text;
      return typeof text === 'string' && text ? [{ type: 'delta', text }] : [];
    }
    case 'agent_thought_chunk': {
      const text = u.content?.text;
      return typeof text === 'string' && text ? [{ type: 'thinking', text }] : [];
    }
    case 'usage_update':
      return u.usage ? [{ type: 'usage', usage: u.usage }] : [];
    case 'tool_call':
      return [{ type: 'activity', title: u.title ?? u.kind ?? 'tool call' }];
    default:
      return [];
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: 6 new passing（总数 71）

- [ ] **Step 5: 提交**

```bash
git add packages/agent-server/src/adapters/acp-stream.mjs packages/agent-server/test/acp-stream.test.mjs
git commit -m "feat(agent-server): map ACP session updates to gateway events"
```

---

### Task 3: ACP 适配器（子进程 + 连接 + 会话）

**Files:**
- Create: `packages/agent-server/src/adapters/acp.mjs`
- Test: `packages/agent-server/test/acp-adapter.test.mjs`
- Create: `packages/agent-server/test/fixtures/fake-acp-agent.mjs`

- [ ] **Step 1: 建假 ACP 服务端夹具**

`packages/agent-server/test/fixtures/fake-acp-agent.mjs` —— 一个最小 ACP 服务端：
读 stdin 的 JSON-RPC，应答 `initialize` / `session/new` / `session/prompt`，
并在 `prompt` 期间推送 `session/update` 通知（含 delta 与 thought），最后回 `end_turn`。

```javascript
#!/usr/bin/env node
// 假 ACP agent：回放固定交互，供适配器测试，不依赖任何真实 agent。
// 环境变量 FAKE_ACP_MODE: ok（默认）| error
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_ACP_MODE ?? 'ok';
const rl = createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: 'fake-acp-session' } });
  } else if (method === 'session/prompt') {
    const sid = params?.sessionId;
    if (mode === 'error') {
      send({ jsonrpc: '2.0', id, result: { stopReason: 'error' } });
      return;
    }
    // 先推通知，再回结果
    send({ jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } } } });
    send({ jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } } } });
    send({ jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'usage_update', usage: { inputTokens: 5, outputTokens: 1 } } } });
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
});
```
`chmod +x` 它。

- [ ] **Step 2: 写失败测试**

```javascript
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
  const kinds = events.map((e) => e.type);
  assert.deepEqual(kinds, ['thinking', 'delta', 'usage', 'turn_end']);
  assert.equal(events[1].text, 'PONG');
  assert.equal(events[3].stopReason, 'end_turn');
});

test('acp adapter reports error stopReason as an error event', async () => {
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

test('acp adapter available() respects a caller-supplied probe', async () => {
  const acp = createAcpAdapter({ agents: {}, probe: async (id) => id === 'hermes' });
  assert.equal(await acp.available('hermes'), true);
  assert.equal(await acp.available('nope'), false);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `chmod +x test/fixtures/fake-acp-agent.mjs && npm test`
Expected: FAIL — module not found

- [ ] **Step 4: 实现**

```javascript
// ACP 适配器：用官方 SDK 通过 stdio JSON-RPC 驱动任意 ACP agent。
// 关键实现细节（已实测，见 spec）：
//  - ndJsonStream(output, input) 参数顺序：output=我们写→agent读
//  - 需要 Web Streams，用 toWeb 转换 Node 流
//  - agent 的 stderr 只进日志，绝不进事件流（hermes 实测输出大量插件日志）
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { mapSessionUpdate } from './acp-stream.mjs';
import { ACP_AGENTS, getAgentDef } from './acp-agents.mjs';

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i].content ?? '');
  }
  return '';
}

export function createAcpAdapter({ agents = ACP_AGENTS, probe } = {}) {
  return {
    id: 'acp',

    // 单个 agent 的可用性：调用方注入 probe，或默认探测命令是否在 PATH
    async availableFor(agentId) {
      if (probe) return probe(agentId);
      const def = getAgentDef(agentId);
      if (!def) return false;
      return await commandExists(def.cmd);
    },

    async *run({ agentId, messages, cwd = process.cwd() }) {
      const def = getAgentDef(agentId);
      if (!def) {
        yield { type: 'error', message: `unknown acp agent: ${agentId}` };
        return;
      }

      const home = mkdtempSync(join(tmpdir(), 'atbx-acp-'));
      const child = spawn(def.cmd, def.args, {
        cwd,
        env: { ...process.env, ...def.isolateEnv(home) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // stderr 必须被消费：不读会填满管道缓冲导致子进程阻塞
      child.stderr.resume();

      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin),   // output：我们写 → agent 读
        Readable.toWeb(child.stdout),  // input： agent 写 → 我们读
      );

      // 事件队列：通知回调与 prompt 的 await 之间桥接
      const queue = [];
      let waiter = null;
      const push = (ev) => { queue.push(ev); const w = waiter; waiter = null; w?.(); };

      const client = {
        async sessionUpdate(params) {
          for (const ev of mapSessionUpdate(params)) push(ev);
        },
        async requestPermission() {
          // 无头环境自动放行一次性权限；真正的安全边界在上层 grant 机制
          return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
        },
        async readTextFile() { throw new Error('fs not supported'); },
        async writeTextFile() { throw new Error('fs not supported'); },
      };

      let settled = false;
      const done = (async () => {
        try {
          const conn = new acp.ClientSideConnection((_agent) => client, stream);
          await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
          const s = await conn.newSession({ cwd, mcpServers: [] });
          const r = await conn.prompt({
            sessionId: s.sessionId,
            prompt: [{ type: 'text', text: lastUserText(messages) }],
          });
          push({ type: 'turn_end', stopReason: r?.stopReason ?? null });
        } catch (err) {
          push({ type: 'error', message: String(err?.message ?? err) });
        } finally {
          settled = true;
          const w = waiter; waiter = null; w?.();
        }
      })();

      try {
        while (queue.length > 0 || !settled) {
          if (queue.length === 0) {
            await new Promise((r) => { waiter = r; });
            continue;
          }
          yield queue.shift();
        }
        while (queue.length) yield queue.shift();
      } finally {
        await done.catch(() => {});
        child.kill('SIGKILL');
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

async function commandExists(cmd) {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolve) => {
    execFile('which', [cmd], (err) => resolve(!err));
  });
}
```

注：`availableFor` 是适配器上的**额外**方法（注册表契约要求的是 `available()`）。
Task 4 会让 server 用它逐 agent 探活；注册表本身的 `available()` 仍返回 `true`
（acp 适配器总是"存在"，只是其下各 agent 未必可用）。

- [ ] **Step 5: 运行确认通过**

Run: `npm test`
Expected: 4 new passing（总数 75）

- [ ] **Step 6: 提交**

```bash
git add packages/agent-server/src/adapters/acp.mjs packages/agent-server/test/acp-adapter.test.mjs packages/agent-server/test/fixtures/fake-acp-agent.mjs
git commit -m "feat(agent-server): ACP adapter driving agents over stdio"
```

---

### Task 4: 服务端集成（每 agent 可用性 + 显式选择）

**Files:**
- Modify: `packages/agent-server/src/server.mjs`
- Modify: `packages/agent-server/test/server.test.mjs`

- [ ] **Step 1: 写失败测试**

在 `test/server.test.mjs` 末尾追加：

```javascript
test('health lists each ACP agent with name and availability', async (t) => {
  const { json } = await withFauxServer(t);
  const { body } = await json('/health');
  const ids = body.agents.map((a) => a.id);
  // 既有适配器保持存在
  assert.ok(ids.includes('pi'));
  // ACP 子 agent 逐个列出
  assert.ok(body.agents.some((a) => a.id === 'acp:hermes' && typeof a.available === 'boolean'));
  assert.ok(body.agents.some((a) => a.id === 'acp:codex' && typeof a.name === 'string'));
});

test('sessions can target a specific acp agent', async (t) => {
  const { json } = await withFauxServer(t);
  const r = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux', agent: 'acp:hermes' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.adapter, 'acp');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: 两个新测试失败（`agents` 里没有 `acp:*` 条目；`agent` 字段未被识别）

- [ ] **Step 3: 改造 server.mjs**

要点：
1. 引入 `createAcpAdapter`，注册进默认注册表：
   ```javascript
   import { createAcpAdapter } from './adapters/acp.mjs';
   import { listAgentIds, getAgentDef } from './adapters/acp-agents.mjs';

   const acpAdapter = createAcpAdapter();
   const reg = registry ?? createRegistry([
     createPiAdapter({ models, resolve }),
     createCcAdapter(),
     acpAdapter,
   ]);
   ```
2. `/health` 的 `agents` 展开：在既有 `await reg.status()` 结果后，为每个 ACP 子 agent 追加条目：
   ```javascript
   const status = await reg.status();
   const acpEntries = [];
   for (const id of listAgentIds()) {
     acpEntries.push({
       id: `acp:${id}`,
       name: getAgentDef(id).name,
       available: await acpAdapter.availableFor(id),
     });
   }
   return json(200, {
     ok: true, version: VERSION,
     agents: [...status, ...acpEntries],
     grantedDirs: loadConfig().grantedDirs,
   });
   ```
3. `/sessions` 支持显式 agent（`acp:<id>` 或直接适配器 id）：
   ```javascript
   let adapter, acpAgentId = null;
   if (typeof body.agent === 'string' && body.agent.startsWith('acp:')) {
     acpAgentId = body.agent.slice(4);
     adapter = acpAdapter;
   } else {
     adapter = await reg.pick(body.agents ?? [body.agent ?? 'pi']);
   }
   ```
   会话对象增加 `acpAgentId` 字段并在 `/messages` 里透传给 `run`：
   ```javascript
   for await (const ev of session.adapter.run({
     ...,
     agentId: session.acpAgentId,   // acp 适配器用；其它适配器忽略
   })) { ... }
   ```
4. `/messages` 的事件分派增加两个新类型：
   ```javascript
   else if (ev.type === 'thinking') send('thinking', { text: ev.text });
   else if (ev.type === 'usage') send('usage', { usage: ev.usage });
   ```

**不要破坏**：既有全部路由守卫、CORS/PNA、SSE 契约（delta/turn_end/error/done 语义不变，仅新增 thinking/usage）。

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: 全部通过（75 + 2 = 77）

- [ ] **Step 5: 冒烟**

```bash
node bin/agenttoolbox-agent.mjs --port 31415 &
sleep 1
curl -s http://127.0.0.1:31415/health | python3 -m json.tool | head -30
kill %1
```
Expected: `agents` 含 `pi`（true）、`cc`、以及 `acp:hermes` / `acp:codex` / … 各带 `available` 布尔。

- [ ] **Step 6: 提交**

```bash
git add packages/agent-server/src/server.mjs packages/agent-server/test/server.test.mjs
git commit -m "feat(agent-server): expose acp agents in health, allow explicit selection"
```

---

### Task 5: 各 agent 实测（决定谁进 UI）

**Files:**
- Create: `packages/agent-server/test/fixtures/README.md`（记录实测结果）

- [ ] **Step 1: 逐个实测**（用 Task 3 的适配器 + 真实 agent）

对每个 agent 跑一次真实调用，记录结论。示例（在 `packages/agent-server` 下）：

```bash
node --input-type=module -e "
import { createAcpAdapter } from './src/adapters/acp.mjs';
const a = createAcpAdapter();
const id = process.argv[1];
console.log('available:', await a.availableFor(id));
for await (const ev of a.run({ agentId: id, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }], cwd: process.cwd() })) {
  console.log(JSON.stringify(ev).slice(0, 160));
}
" hermes
```

逐个替换 `hermes` 为 `openclaw` / `opencode` / `codex` / `dsh`。

- [ ] **Step 2: 记录结果**

在 `test/fixtures/README.md` 写一张表：agent / 是否可用 / 实测输出摘要 / 备注（如 openclaw 需先起 Gateway）。**跑不通的 agent 在 Task 6 从 UI 隐藏并在此注明原因。**

- [ ] **Step 3: 提交**

```bash
git add packages/agent-server/test/fixtures/README.md
git commit -m "docs(agent-server): record per-agent ACP verification results"
```

---

### Task 6: 前端（Agent 下拉 + 思维链渲染）

**Files:**
- Modify: `src/lib/agentchat.ts`
- Modify: `src/lib/agentchat.test.ts`
- Modify: `src/pages/free-models.astro`

- [ ] **Step 1: 扩展类型与测试**

`agentchat.ts`：

```typescript
export interface AgentStatus { id: string; name?: string; available: boolean }

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'usage'; usage: unknown }
  | { type: 'turn_end'; stopReason: string | null }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface SessionRequest {
  // ...既有字段...
  agent?: string | null;
}
```

测试：`parseSSEChunk` 能解析 `thinking` 帧：

```typescript
it('parses a thinking frame', () => {
  const { events } = parseSSEChunk('data: {"type":"thinking","text":"hmm"}\n\n');
  expect(events).toEqual([{ type: 'thinking', text: 'hmm' }]);
});
```

- [ ] **Step 2: 抽屉加 Agent 下拉**

`free-models.astro` 抽屉头部：

```astro
<label for="chat-agent" class="chat-agent-label">Agent</label>
<select id="chat-agent" class="chat-agent"></select>
```

脚本：
- `probeHealth()` 后，把 `health.agents.filter(a => a.available)` 填进下拉；
- 默认选中第一个（或记住 localStorage `atbx:agent`）；
- 切换时：`stopProbe()` + 清空 `chat.sessionId`（换 agent = 新会话）+ 重建；
- 若可用 agent ≤ 1，隐藏下拉（避免无意义的 UI）；
- `ensureSession()` 把选中值作为 `agent` 传入 `createSession`。

- [ ] **Step 3: 思维链渲染**

`streamMessage` 的 onEvent 里：

```typescript
else if (ev.type === 'thinking') thinkDiv.textContent += ev.text;
```
思维链用一个弱化样式的独立元素（斜体、浅色、可折叠），与正式回复的 `outDiv` 分开：

```css
.chat-msg--thinking { font-style: italic; color: var(--ink-soft); opacity: .85; font-size: .88rem; }
```

- [ ] **Step 4: 验证**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: vitest 全绿（含新 thinking 测试）；tsc 0；11 页构建。

- [ ] **Step 5: 浏览器验证**

起网关 → dev server → 打开 free-models → 点 Chat → 确认：
下拉列出可用 agent；多轮对话正常；思维链以弱化样式显示。截图存档。

- [ ] **Step 6: 提交**

```bash
git add src/lib/agentchat.ts src/lib/agentchat.test.ts src/pages/free-models.astro
git commit -m "feat(site): agent selector and thinking-chain rendering"
```

---

### Task 7: 发布 0.3.0 与收尾

**Files:**
- Modify: `packages/agent-server/package.json`（version → 0.3.0）
- Modify: `packages/agent-server/README.md`
- Remove: `scripts/verify/`

- [ ] **Step 1: README 补充**

新增 `Agents` 一节：列出支持的 agent、各自的 ACP 入口、隔离变量、以及**哪些已实测通过**（引用 Task 5 的结果表）。更新 `/health` 与 `/sessions` 文档（`agent` 字段、`acp:*` 条目、`thinking`/`usage` 事件）。

- [ ] **Step 2: 版本号 → 0.3.0**

- [ ] **Step 3: 全量回归**

Run: `npm test && npm run build && (cd packages/agent-server && npm test)`
Expected: 站点全绿；11 页；网关全绿

- [ ] **Step 4: 清理验证脚本**

```bash
git rm -r scripts/verify && rm -rf scripts/verify
```

- [ ] **Step 5: 提交并打 tag**

```bash
git add packages/agent-server/package.json packages/agent-server/README.md
git commit -m "chore(agent-server): 0.3.0 — multi-agent ACP support"
git tag agent-server-v0.3.0
```

- [ ] **Step 6: 人工步骤（交给用户）**

本地 `npm publish`（passkey）；推 tag 触发 OIDC 发布或本地发；合并分支 → 部署。

---

## Self-Review 记录

**Spec 覆盖**：agent 定义表（T1）、通知映射（T2）、ACP 适配器（T3）、服务端集成（T4）、
实测（T5）、前端下拉+思维链（T6）、发布（T7）✓。手工剔除 workbuddy/cursor 已在 spec
说明（T1 表中本就不含）。不做网关层 ✓。

**占位符**：T5 的实测是"跑命令看结果"而非写死代码，属必要的运行时验证，非占位符；
T5 Step 2 要求把结果写进 README（有明确表格要求）。

**类型一致性**：`AgentEvent` 在 T2 定义（含新增 `thinking`/`usage`/`activity`）、
T3 产出、T4 转发、T6 消费，字段名一致；`availableFor(agentId)`（T3 定义）在 T4 使用；
`acp:<id>` 命名在 T4（服务端）与 T6（前端）一致。

**已知风险（spec 已列，实现时验证）**：openclaw 实测超时；codex/dsh/opencode 的 ACP
入口为调研推测；隔离变量名需实测确认。T5 正是为此设的关卡——跑不通就隐藏，不硬撑。
