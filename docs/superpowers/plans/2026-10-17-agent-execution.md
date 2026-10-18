# Agent Execution Implementation Plan（期 1 + 期 2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat 抽屉从纯对话升级为本地智能体执行：会话绑定工作目录、按级别启用工具（只读→完整）、危险动作经抽屉权限卡逐个确认，并展示用量/额度。

**Architecture:** 会话状态扩展 `cwd` + `toolTier`（none/read/full）。三适配器按级别启用工具：pi 手写 AgentTool（read/write/bash + cwd 硬约束）挂进 pi-agent-core initialState；cc 用 `--allowedTools` 分级 + stream-json 双向控制流（can_use_tool 权限转发）；acp 用原生 `request_permission` 转发。危险动作统一经网关 permission 中枢（挂起 → SSE `permission_request` → 抽屉权限卡 → 应答端点，120s 超时自动拒绝）。

**Tech Stack:** 既有栈不变；新增无（pi 工具用 node:fs/node:child_process + pi-ai 的 Type schema）。

**Spec:** `docs/superpowers/specs/2026-10-17-agent-execution-design.md`

**已验证事实（实现直接依赖）：**
- pi-agent-core：`Agent` initialState 支持 `tools: AgentTool[]`；`AgentTool extends Tool`（pi-ai）：`{name, description, parameters: TypeSchema, label, execute(toolCallId, params, signal?, onUpdate?) → Promise<{content:[{type:'text',text}], details, isError?}>}`；schema 用 `Type`（pi-ai 重导出 TypeBox 的 `Type`）
- pi 工具抛错 → agent loop 自动转 isError 结果（不会崩会话）
- cc：`--input-format stream-json` 可双向驱动——stdin 收 `{"type":"user","message":{...}}` 与 `{"type":"control_response",...}`；stdout 出 `control_request`（含 `can_use_tool` 权限请求）
- acp：agent 会向 client 发 `session/request_permission` JSON-RPC 请求，client 实现的 `requestPermission` 处理器收到后返回 outcome 即完成应答
- 既有：registry/pi/cc/acp 适配器、permission 尚未实现、`encodeSSE` 透传任意类型

---

# 期 1

### Task 1: 会话 cwd/toolTier 校验与存储

**Files:**
- Modify: `packages/agent-server/src/server.mjs`
- Modify: `packages/agent-server/test/server.test.mjs`

- [ ] **Step 1: 写失败测试**（追加到 test/server.test.mjs）

```javascript
test('sessions accept and validate cwd + toolTier', async (t) => {
  const { json } = await withFauxServer(t);
  const mk = (body) => json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify(body),
  });
  const ok = await mk({ provider: 'faux', model: 'faux', cwd: '/tmp', toolTier: 'read' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.cwd, '/tmp');
  assert.equal(ok.body.toolTier, 'read');

  const bad = await mk({ provider: 'faux', model: 'faux', cwd: '/no/such/dir-xyz' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid cwd');

  const def = await mk({ provider: 'faux', model: 'faux' });
  assert.equal(def.body.toolTier, 'none');
  assert.equal(def.body.cwd, null);
});
```

- [ ] **Step 2: 确认失败** — `npm test` → 新测试失败（响应无 cwd/toolTier）

- [ ] **Step 3: 实现**（server.mjs）

imports 增加 `statSync`：
```javascript
import { statSync } from 'node:fs';
```

`/sessions` 在 adapter 选择**之前**插入：
```javascript
        // 工作目录：可选。给出时必须存在且是目录，否则 400（前端显示明确错误）。
        const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : null;
        if (cwd) {
          try {
            if (!statSync(cwd).isDirectory()) throw new Error('not a directory');
          } catch {
            return json(400, { error: 'invalid cwd', message: `working directory not accessible: ${cwd}` });
          }
        }
        // 工具级别：none=纯对话（默认，与现状一致）| read=只读工具。
        // 未知值安全回落 none，绝不因误传升级权限。
        const toolTier = ['none', 'read'].includes(body.toolTier) ? body.toolTier : 'none';
```

`/sessions` 的 adapter 选择改为（cwd 传给所有适配器）：
```javascript
        const adapter = await reg.pick(body.agents ?? ['pi']);
```
不变；`sessions.set` 增加字段并回显：
```javascript
        sessions.set({
          id, adapter, request: body, apiKey: body.apiKey ?? null,
          cwd, toolTier, grantedDirs: loadConfig().grantedDirs,
          ccSessionId: null, lastUsed: Date.now(), streaming: false,
        });
        return json(200, { sessionId: id, adapter: adapter.id, provider: body.provider, model: body.model, cwd, toolTier });
```

`/messages` 的 run 调用把 cwd 改为对所有适配器生效（原 cc-only 逻辑删除）：
```javascript
        const isCc = session.adapter.id === 'cc';
        const allowedTools = isCc && session.toolTier === 'read' ? ['Read', 'Grep', 'Glob'] : [];
```
run ctx 中 `cwd` 改为：
```javascript
            cwd: session.cwd ?? undefined,
```
（`grantedDirs` 保留存储与 /health 展示；不再参与 allowedTools——由 toolTier 统一驱动。）

- [ ] **Step 4: 确认通过** — `npm test` → 80 passing（76 + 4…… 以实际新增断言数为准；既有 cc-only allowedTools 相关断言若有变动，同步更新为 tier 驱动语义）

- [ ] **Step 5: 提交**

```bash
git add packages/agent-server/src/server.mjs packages/agent-server/test/server.test.mjs
git commit -m "feat(agent-server): per-session cwd and tool tier"
```
(End trailer: `Co-Authored-By: Claude Code <noreply@anthropic.com>`)

---

### Task 2: pi 只读工具实现（pi-tools.mjs）

**Files:**
- Create: `packages/agent-server/src/adapters/pi-tools.mjs`
- Test: `packages/agent-server/test/pi-tools.test.mjs`

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confine, makeReadFile, makeListDir, makeGrep } from '../src/adapters/pi-tools.mjs';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tools-'));
  writeFileSync(join(dir, 'README.md'), '# hello\nworld\n');
  writeFileSync(join(dir, 'app.ts'), 'const x = 42;\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'util.ts'), 'export const y = 1;\n');
  return dir;
}

test('confine resolves inside cwd and blocks traversal', () => {
  const dir = sandbox();
  assert.equal(confine(dir, 'README.md'), join(dir, 'README.md'));
  assert.throws(() => confine(dir, '../outside'), /escapes working directory/);
  assert.throws(() => confine(dir, '/etc/passwd'), /escapes working directory/);
  rmSync(dir, { recursive: true, force: true });
});

test('read_file returns text content', async () => {
  const dir = sandbox();
  const tool = makeReadFile(dir);
  const r = await tool.execute('id1', { path: 'README.md' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /# hello/);
  rmSync(dir, { recursive: true, force: true });
});

test('read_file blocks traversal as tool error', async () => {
  const dir = sandbox();
  const tool = makeReadFile(dir);
  const r = await tool.execute('id1', { path: '../../../etc/passwd' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /escapes working directory/);
  rmSync(dir, { recursive: true, force: true });
});

test('list_dir lists entries with dir suffix', async () => {
  const dir = sandbox();
  const tool = makeListDir(dir);
  const r = await tool.execute('id1', { path: '' });
  const lines = r.content[0].text.split('\n').sort();
  assert.deepEqual(lines, ['README.md', 'app.ts', 'src/']);
  rmSync(dir, { recursive: true, force: true });
});

test('grep searches recursively, skips node_modules and caps matches', async () => {
  const dir = sandbox();
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'x.ts'), 'const x = 42;\n');
  const tool = makeGrep(dir);
  const r = await tool.execute('id1', { pattern: 'const x', include: '*.ts' });
  const lines = r.content[0].text.split('\n');
  assert.ok(lines.every((l) => !l.includes('node_modules')), 'skips node_modules');
  assert.equal(lines.length, 2, 'app.ts + src/util.ts');
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 确认失败** — `npm test` → module not found

- [ ] **Step 3: 实现** — `src/adapters/pi-tools.mjs`：

```javascript
// pi 只读工具（期 1）：read_file / list_dir / grep。
// 硬边界：所有路径 resolve 后必须落在 cwd 内；grep 跳过依赖/隐藏目录、
// 单文件 1MB 上限、最多 50 条匹配。写/执行工具在期 2 另行实现并接确认流。
import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', 'dist', 'build', '.next', '__pycache__']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_GREP_MATCHES = 50;

// 路径硬边界：resolve 后必须等于 base 或以其为前缀。符号链接 resolve 后同样受检。
export function confine(cwd, relPath) {
  const base = resolve(cwd);
  const abs = resolve(base, String(relPath ?? ''));
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`path escapes working directory: ${relPath}`);
  }
  return abs;
}

export function makeReadFile(cwd) {
  return {
    name: 'read_file',
    label: 'Read file',
    description: 'Read a text file inside the working directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path within the working directory' } },
      required: ['path'],
    },
    execute: async (_id, params) => {
      try {
        const abs = confine(cwd, params.path);
        const st = await fs.stat(abs);
        if (st.size > MAX_FILE_BYTES) throw new Error(`file too large (>1MB): ${params.path}`);
        const text = await fs.readFile(abs, 'utf8');
        return { content: [{ type: 'text', text }], details: { bytes: st.size } };
      } catch (err) {
        return { content: [{ type: 'text', text: String(err?.message ?? err) }], details: {}, isError: true };
      }
    },
  };
}

export function makeListDir(cwd) {
  return {
    name: 'list_dir',
    label: 'List directory',
    description: 'List entries of a directory inside the working directory ("dir/" suffix marks directories).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative directory path; empty string = working directory root' } },
    },
    execute: async (_id, params) => {
      try {
        const abs = confine(cwd, params.path ?? '');
        const entries = await fs.readdir(abs, { withFileTypes: true });
        const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
        return { content: [{ type: 'text', text: lines.join('\n') || '(empty)' }], details: { count: entries.length } };
      } catch (err) {
        return { content: [{ type: 'text', text: String(err?.message ?? err) }], details: {}, isError: true };
      }
    },
  };
}

// 同步 walk（工具内递归量可控：跳过重目录 + 匹配上限截断）
function collectFilesSync(dir, out, depth = 0) {
  if (depth > 12) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      collectFilesSync(join(dir, e.name), out, depth + 1);
    } else if (e.isFile()) {
      out.push(join(dir, e.name));
    }
  }
}

export function makeGrep(cwd) {
  return {
    name: 'grep',
    label: 'Search text',
    description: 'Case-insensitive search across text files in the working directory. Returns up to 50 lines as "path:line: text".',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern' },
        include: { type: 'string', description: 'Optional filename substring filter, e.g. ".ts"' },
      },
      required: ['pattern'],
    },
    execute: async (_id, params) => {
      try {
        const re = new RegExp(params.pattern, 'i');
        const base = resolve(cwd);
        const files = [];
        collectFilesSync(base, files);
        const matches = [];
        for (const file of files) {
          const st = fs.statSync(file);
          if (st.size > MAX_FILE_BYTES) continue;
          const rel = file.slice(base.length + 1).split(sep).join('/');
          if (params.include && !rel.includes(params.include)) continue;
          let text;
          try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              matches.push(`${rel}:${i + 1}: ${lines[i].slice(0, 200)}`);
              if (matches.length >= MAX_GREP_MATCHES) break;
            }
          }
          if (matches.length >= MAX_GREP_MATCHES) break;
        }
        const text = matches.length ? matches.join('\n') : 'no matches';
        return { content: [{ type: 'text', text }], details: { matches: matches.length } };
      } catch (err) {
        return { content: [{ type: 'text', text: String(err?.message ?? err) }], details: {}, isError: true };
      }
    },
  };
}

export function readOnlyTools(cwd) {
  return [makeReadFile(cwd), makeListDir(cwd), makeGrep(cwd)];
}
```

注意：`parameters` 直接用 JSON Schema 对象（pi-ai 的 Tool.parameters 接受 TSchema=TypeBox 输出，亦兼容裸 JSON Schema；若实测 Strict 校验拒绝，改用 `import { Type } from '@earendil-works/pi-ai'` 构造，形状不变）。实现者必须先在 node 环境实测一个 read_file 调用被 agent loop 正常接受（fake provider + tools 冒烟），确认 schema 形状可用后再定稿。

- [ ] **Step 4: 确认通过** — `npm test` → 6 new passing（86）

- [ ] **Step 5: 提交**

```bash
git add packages/agent-server/src/adapters/pi-tools.mjs packages/agent-server/test/pi-tools.test.mjs
git commit -m "feat(agent-server): pi read-only tools with cwd confinement"
```
(End trailer: `Co-Authored-By: Claude Code <noreply@anthropic.com>`)

---

### Task 3: pi 适配器接入工具（tier → tools）

**Files:**
- Modify: `packages/agent-server/src/adapters/pi.mjs`
- Modify: `packages/agent-server/test/pi-adapter.test.mjs`

- [ ] **Step 1: 写失败测试**

```javascript
test('pi adapter attaches read tools when tier is read', async () => {
  const { models, faux } = fauxSetup();
  faux.setResponses([fauxAssistantMessage([fauxText('ok')])]);
  let seenTools;
  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
    makeAgent: (_m, model, sessionId, apiKey, tools) => {
      seenTools = tools;
      return null;  // 测试桩：不需要真 Agent（run 内部若 makeAgent 返回 null 会抛错——改为捕获后直接结束）
    },
  });
  // 说明：makeAgent 返回 null 会让 run 内部抛错 → error 事件。本测试只断言
  // makeAgent 收到的 tools 数组非空且元素含 name/execute。
  const events = await collect(pi.run({
    messages: [{ role: 'user', content: 'hi' }],
    request: { provider: 'faux', model: 'faux' },
    apiKey: null, toolTier: 'read', cwd: '/tmp',
  })).catch(() => []);
  assert.ok(Array.isArray(seenTools) && seenTools.length === 3, '3 read tools passed');
  assert.ok(seenTools.every((t) => typeof t.name === 'string' && typeof t.execute === 'function'));
});
```

（该测试依赖 pi.mjs 的实现方式——见 Step 3。若实现把工具构造放在 makeAgent 之外，测试改为对 `readOnlyTools(cwd)` 返回值的直接断言 + makeAgent 接收 `tools` 参数的形状断言。以「能证明 tier=read 时工具被构造并传入 Agent」为准。）

- [ ] **Step 2: 确认失败** — `npm test` → 新测试失败

- [ ] **Step 3: 实现** — `pi.mjs`：

1. import：`import { readOnlyTools } from './pi-tools.mjs';`
2. `createPiAdapter({ models, resolve, makeAgent = defaultMakeAgent, capacity = 16 })` 不变；`defaultMakeAgent` 增加第 5 参 `tools`：
   ```javascript
   function defaultMakeAgent(models, model, sessionId, apiKey, tools) {
     return new Agent({
       initialState: { systemPrompt: SYSTEM_PROMPT, model, ...(tools ? { tools } : {}) },
       streamFn: (m, context, options) => models.streamSimple(m, context, {
         ...options, timeoutMs: STREAM_TIMEOUT_MS, fetch: longTimeoutFetch,
       }),
       sessionId,
       getApiKey: () => apiKey,
     });
   }
   ```
3. `run` ctx 增加 `toolTier, cwd`；工具解析：
   ```javascript
   const tools = toolTier === 'read' && cwd ? readOnlyTools(cwd) : undefined;
   const agent = makeAgent(models, model, sessionId, apiKey, tools);
   ```
4. 缓存键把 cwd/toolTier 纳入（cwd/tier 变更 = 换工具集，必须重建 Agent）：
   ```javascript
   const cacheKey = (model, apiKey, cwd, toolTier) =>
     `${model.provider}/${model.id}\u0000${apiKey ?? ''}\u0000${cwd ?? ''}\u0000${toolTier ?? ''}`;
   ```
   （`agentFor` 签名同步更新。）

- [ ] **Step 4: 确认通过** — `npm test` → 全绿（含新测试）

- [ ] **Step 5: 提交**

```bash
git add packages/agent-server/src/adapters/pi.mjs packages/agent-server/test/pi-adapter.test.mjs
git commit -m "feat(agent-server): pi adapter attaches read tools by tier"
```
(End trailer: `Co-Authored-By: Claude Code <noreply@anthropic.com>`)

---

### Task 4: cc 工具分级（tier → allowedTools）

**Files:**
- Modify: `packages/agent-server/src/server.mjs`（tier 已存储；把 run ctx 的 allowedTools 改为 tier 驱动）
- Modify: `packages/agent-server/test/server.test.mjs`

- [ ] **Step 1: 写失败测试**

```javascript
test('cc tool tier drives allowedTools passthrough', async (t) => {
  // 用真实 cc 适配器 + echo 夹具断言 --allowedTools argv 随 tier 变化
  const { base, json } = await withCcEchoServer(t);
  const create = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'x', model: 'm', agent: 'cc', cwd: '/tmp', toolTier: 'read' }),
  });
  assert.equal(create.body.adapter, 'cc');
  const res = await fetch(`${base}/sessions/${create.body.sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'hi' }),
  });
  await res.text();
  // echo 夹具把收到的 --allowedTools 值作为 delta 回显
  assert.match(await res.text(), /Read,Grep,Glob/);
});
```

（`withCcEchoServer` 是新 helper：`startServer` + registry 仅含 cc 适配器、`cliPath` 指向一个回显 argv 的 shell 夹具 `test/fixtures/cc-echo-argv.sh`——把 stdin 首行与 argv 均以 delta 回显后退出。实现者按此写夹具与 helper。）

- [ ] **Step 2: 确认失败** — `npm test` → 新测试失败

- [ ] **Step 3: 实现** — server.mjs `/messages` 的 allowedTools 改为 tier 驱动：

```javascript
        const isCc = session.adapter.id === 'cc';
        // 工具分级（期 1）：none=不给工具；read=只读三件套；full 期 2 实现
        const allowedTools = isCc && session.toolTier === 'read' ? ['Read', 'Grep', 'Glob'] : [];
        const cwd = isCc ? (session.cwd ?? session.grantedDirs?.[0] ?? undefined) : undefined;
```
（grantedDirs 作为 cwd 的回退保留；tier 驱动工具集。）

- [ ] **Step 4: 确认通过** — `npm test` → 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/agent-server/src/server.mjs packages/agent-server/test/server.test.mjs packages/agent-server/test/fixtures/cc-echo-argv.sh
git commit -m "feat(agent-server): tier-driven allowedTools for cc adapter"
```
(End trailer: `Co-Authored-By: Claude Code <noreply@anthropic.com>`)

---

### Task 5: acp 启发式权限应答

**Files:**
- Modify: `packages/agent-server/src/adapters/acp.mjs`
- Modify: `packages/agent-server/test/acp-adapter.test.mjs`

- [ ] **Step 1: 写失败测试**

```javascript
test('acp requestPermission allows read-only tools in read tier', async () => {
  // 夹具发送 session/request_permission（只读工具）→ 应答 allow
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
  assert.ok(events.some((e) => e.type === 'delta' && /deny/i.test(e.text)), 'perm answered deny');
});
```

夹具 `fake-acp-agent.mjs` 增加 `--perm-req <title>` 参数模式：发送
`session/request_permission`（params 含 `toolCall: {title: <title>, kind: 'read'}`，
options 含 `allow_once`/`reject_once` 两个选项），把 client 返回的 outcome 回显为
delta 后正常 end_turn。

- [ ] **Step 2: 确认失败** — `npm test` → 夹具收不到应答/超时

- [ ] **Step 3: 实现** — `acp.mjs` 的 client.requestPermission 改为 tier 驱动：

```javascript
        async requestPermission(req) {
          // 期 1 启发式：只读类工具在 read 级别放行；写/执行类一律拒绝。
          // 期 2 替换为转发抽屉确认（见 spec 期 2）。
          const call = req?.toolCall ?? {};
          const title = String(call.title ?? call.name ?? '');
          const kind = String(call.kind ?? '');
          const readonly = /read|view|grep|glob|search|list|find|inspect|ls/i.test(`${title} ${kind}`);
          const allow = toolTier === 'read' && readonly;
          console.assert(allow || toolTier !== 'read', `acp perm ${allow ? 'allow' : 'deny'}: ${title}`);
          return { outcome: { outcome: 'selected', optionId: allow ? 'allow_once' : 'reject_once' } };
        },
```
`run` ctx 增加 `toolTier`（server 传入）。

- [ ] **Step 4: 确认通过** — `npm test` → 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/agent-server/src/adapters/acp.mjs packages/agent-server/test/acp-adapter.test.mjs packages/agent-server/test/fixtures/fake-acp-agent.mjs
git commit -m "feat(agent-server): tier-aware acp permission answers"
```
(End trailer: `Co-Authored-By: Claude Code <noreply@anthropic.com>`)

---

### Task 6: POST /quota/openrouter

**Files:**
- Modify: `packages/agent-server/src/server.mjs`
- Modify: `packages/agent-server/test/server.test.mjs`

- [ ] **Step 1: 写失败测试**

```javascript
test('quota/openrouter proxies the key endpoint without logging the key', async (t) => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), auth: opts?.headers?.authorization });
    return new Response(JSON.stringify({ data: {
      usage: 3, limit: 50, is_free_tier: true, rate_limit: { requests: 20, interval: '10s' },
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { json } = await withFauxServer(t);
    const r = await json('/quota/openrouter', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ apiKey: 'sk-or-test' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.usage, 3);
    assert.equal(r.body.limit, 50);
    assert.equal(r.body.isFreeTier, true);
    assert.deepEqual(r.body.rateLimit, { requests: 20, interval: '10s' });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /openrouter\.ai\/api\/v1\/key/);
  } finally { globalThis.fetch = origFetch; }
});

test('quota/openrouter without key returns 400', async (t) => {
  const { json } = await withFauxServer(t);
  const r = await json('/quota/openrouter', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 400);
});
```

- [ ] **Step 2: 确认失败** — `npm test` → 新测试失败

- [ ] **Step 3: 实现**（server.mjs，/health 路由之后插入）：

```javascript
      // OpenRouter 免费额度查询：用户 key 查自己的账号，天然安全。
      // key 走请求体，不进 URL/日志。
      if (req.method === 'POST' && url.pathname === '/quota/openrouter') {
        const body = await readJson(req);
        const key = typeof body?.apiKey === 'string' ? body.apiKey : '';
        if (!key) return json(400, { error: 'apiKey required' });
        const upstream = await fetch('https://openrouter.ai/api/v1/key', {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!upstream.ok) return json(upstream.status, { error: 'upstream error', status: upstream.status });
        const data = (await upstream.json())?.data ?? {};
        return json(200, {
          usage: data.usage ?? null,
          limit: data.limit ?? null,
          isFreeTier: data.is_free_tier ?? null,
          rateLimit: data.rate_limit ?? null,
        });
      }
```

- [ ] **Step 4: 确认通过** — `npm test` → 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/agent-server/src/server.mjs packages/agent-server/test/server.test.mjs
git commit -m "feat(agent-server): OpenRouter quota proxy endpoint"
```
(End trailer: `Co-Authored-By: Claude Code <noreply@anthropic.com>`)

---

### Task 7: 前端（cwd 输入 + 级别下拉 + 用量区）

**Files:**
- Modify: `src/lib/agentchat.ts`
- Modify: `src/pages/free-models.astro`

- [x] **Step 1: 类型扩展**（agentchat.ts）

```typescript
export interface SessionRequest {
  // ...既有字段...
  cwd?: string | null;
  toolTier?: 'none' | 'read';
}
export interface SessionResponse {
  sessionId: string; adapter: string; provider: string; model: string;
  cwd: string | null; toolTier: 'none' | 'read';
}
export interface OpenRouterQuota {
  usage: number | null; limit: number | null;
  isFreeTier: boolean | null; rateLimit: { requests: number; interval: string } | null;
}
export async function fetchOpenRouterQuota(apiKey: string, baseUrl = AGENT_URL): Promise<OpenRouterQuota | null> {
  try {
    const res = await fetch(`${baseUrl}/quota/openrouter`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    if (!res.ok) return null;
    return (await res.json()) as OpenRouterQuota;
  } catch { return null; }
}
```
（`createSession` 返回值如需 cwd/toolTier 回显，一并调整。）

- [x] **Step 2: 抽屉 UI**（free-models.astro）

chat-agent-row 之后加配置行（默认 hidden，health + key 就绪后显示）：

```astro
<div class="chat-config-row" id="chat-config-row" hidden>
  <label for="chat-cwd">Work dir</label>
  <input id="chat-cwd" type="text" placeholder="/home/you/project" autocomplete="off" spellcheck="false" />
  <select id="chat-tier" class="chat-tier">
    <option value="none">Chat only</option>
    <option value="read">+ Read files</option>
  </select>
</div>
<div id="chat-usage" class="chat-usage" hidden></div>
```

样式：
```css
.chat-config-row { display: flex; align-items: center; gap: .5rem; margin-top: .6rem; font-size: .85rem; }
.chat-config-row input#chat-cwd { flex: 1; background: var(--surface); color: inherit; border: 1px solid var(--line-strong); border-radius: 6px; padding: .3rem .5rem; font-size: .85rem; }
.chat-usage { font-size: .8rem; color: var(--ink-soft); }
```

脚本：
- `ensureSession()` 读取 `$('chat-cwd').value.trim()` 与 `$('chat-tier').value`，非空 cwd 才允许 read 级别（否则强制 none 并提示）；`createSession({..., cwd: c.cwd || null, toolTier: c.toolTier})`
- cwd 输入框 change（失焦）或 tier change → 清 sessionId 重新 ensureSession（与换 agent 同模式）；无效路径 → chatMsg error 提示
- 会话建立后：若 `chat.provider === 'openrouter'`，`fetchOpenRouterQuota(key)` → 填充 `#chat-usage`：`已用 3 · 限额 50 请求/天`（limit 为 null 时显示 `免费档 50/天`，isFreeTier false 且 limit 为 null 时显示 `不限`）
- 每次 turn_end 后如有 usage 事件 → 追加 `上下文 used/size`
- tier 值与 cwd 存 `localStorage['atbx:tier'/'atbx:cwd']` 供下次预填（可选）

- [x] **Step 3: 验证**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: 全绿；11 页

- [x] **Step 4: 浏览器验证**

网关起 31415 → 打开页面 → 点 Chat：
1. 配置行出现；输入无效路径 → 错误提示；输入 `/tmp` → 会话创建
2. 选 read 级别 → 对话后 agent 能引用 cwd 内文件内容（真实 pi 工具实测：`grep` 一个项目里的关键字）
3. 截图存档

- [x] **Step 5: 提交**

```bash
git add src/lib/agentchat.ts src/pages/free-models.astro
git commit -m "feat(site): per-session work dir, tool tier and usage display"
```
(End trailer: `Co-Authored-By: Claude Code <noreply@anthropic.com>`)

---

### Task 8: 期 1 端到端实测 + 发布 0.4.0

**Files:**
- Modify: `packages/agent-server/package.json`（version → 0.4.0）
- Modify: `packages/agent-server/README.md`（cwd/toolTier/quota/新 SSE 事件文档）

- [ ] **Step 1: 全量回归**

Run: `npm test && npm run build && (cd packages/agent-server && npm test)`
Expected: 站点全绿；11 页；网关全绿

- [ ] **Step 2: README 更新**（/sessions 的 cwd/toolTier、/quota/openrouter、SSE thinking/usage/activity、工具分级语义）

- [ ] **Step 3: 版本 0.4.0 + 提交 + tag**

```bash
git add packages/agent-server/package.json packages/agent-server/README.md
git commit -m "chore(agent-server): 0.4.0 — work dir, tool tiers, quota"
git tag agent-server-v0.4.0
```

- [ ] **Step 4: 端到端实测**（真实目录 + 只读工具 + pi 对话引用文件内容），结果记入 `packages/agent-server/test/fixtures/README.md`

- [ ] **Step 5: push（main + branch + tag）→ CI 发布 0.4.0 → 线上验证**

---

# 期 2

### Task 9: 网关 permission 中枢

**Files:**
- Modify: `packages/agent-server/src/server.mjs`
- Modify: `packages/agent-server/test/server.test.mjs`

- [ ] **Step 1: 写失败测试**

```javascript
test('permission_request flows to SSE and resolves via answer endpoint', async (t) => {
  // 注入一个「要权限」的假适配器：yield permission_request 事件后挂起等 ctx.answer
  // （适配器 run ctx 新增 answer(decision) —— 由 server 提供）
  const { json, base } = await withPermissionStubServer(t);
  const create = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'stub', model: 'stub' }),
  });
  const { sessionId } = create.body;
  const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'hi' }),
  });
  // 读 SSE 直到收到 permission_request
  const reader = res.body.getReader();
  // ...（测试内解析 SSE 帧，断言收到 {type:'permission_request', reqId, action:'bash', summary:...}）
  // 然后 POST /sessions/:id/permission {reqId, decision:'allow'} → 204
  // 继续读流断言后续 delta/done
});
```

（完整可运行测试由实现者基于 `withFauxServer` 模式展开：stub 适配器 run 里
`const ok = await ctx.requestApproval('bash', 'run tests')` → yield delta('approved'/'denied')。）

- [ ] **Step 2: 实现**

server.mjs：
- `/messages` run ctx 增加：
  ```javascript
  requestApproval: (action, summary) => new Promise((resolve) => {
    const reqId = randomUUID();
    session.pendingPerms.set(reqId, (allow) => {
      session.pendingPerms.delete(reqId);
      resolve(allow);
    });
    send('permission_request', { reqId, action, summary });
    // 120s 超时自动拒绝
    const t = setTimeout(() => { if (session.pendingPerms.delete(reqId)) resolve(false); }, 120_000);
    t.unref?.();
  }),
  ```
- 会话对象增加 `pendingPerms: new Map()`
- 新端点：
  ```javascript
  const permMatch = req.method === 'POST' && url.pathname.match(/^\/sessions\/([0-9a-f-]+)\/permission$/);
  if (permMatch) {
    const session = sessions.get(permMatch[1]);
    if (!session) return json(404, { error: 'unknown session' });
    const body = await readJson(req);
    const cb = session.pendingPerms.get(body.reqId);
    if (!cb) return json(404, { error: 'unknown permission request' });
    session.pendingPerms.delete(body.reqId);
    cb(body.decision === 'allow');
    return json(200, { ok: true });
  }
  ```
- `/abort` 时同时拒绝所有 pendingPerms（防泄漏）

- [ ] **Steps: 测试 → 通过 → 提交**

Run: `npm test` → 全绿（+2 或更多）
```bash
git add packages/agent-server/src/server.mjs packages/agent-server/test/server.test.mjs
git commit -m "feat(agent-server): permission broker with drawer approval"
```
(End trailer: `Co-Authored-By: Claude Code <noreply@anthropic.com>`)

---

### Task 10: pi 写/执行工具 + 确认接入

**Files:**
- Modify: `packages/agent-server/src/adapters/pi-tools.mjs`
- Modify: `packages/agent-server/src/adapters/pi.mjs`
- Test: `packages/agent-server/test/pi-tools.test.mjs`

- [ ] **Step 1: 写失败测试**（makeWriteFile/makeBash + 确认拒绝/放行两路径；bash 夹具用 `node -e process.stdout.write('ok')` 避免依赖 shell）

- [ ] **Step 2-4: 实现**（write_file 约束同 read；bash 用 `node:child_process` execFile('bash',['-lc',cmd],{cwd})，输出截断 8KB，超时 60s；execute 前先 `await requestApproval(action, preview)`，拒绝 → isError 结果 'denied by user'）

- [ ] **Step 5: 提交** — `feat(agent-server): pi write/bash tools with approval gate`

---

### Task 11: cc MCP 权限桥

**Files:**
- Create: `packages/agent-server/src/adapters/cc-perm-bridge.mjs`（MCP stdio 服务 + 回环回调）
- Modify: `packages/agent-server/src/adapters/cc.mjs`（toolTier full 时追加 `--input-format stream-json` + `--mcp-config <临时文件>` + `--permission-prompt-tool confirm_action`；解析 stdout 的 control_request/can_use_tool，转发抽屉后回写 control_response）
- Test: `packages/agent-server/test/cc-perm-bridge.test.mjs`

**实现要点（调研已确认 CC 协议）：**
- `--permission-prompt-tool <name>`：CC 对每个非白名单工具调用名为 `<name>` 的 MCP 工具，
  入参 `{tool_name, input}`，期望返回 `{behavior:'allow', updatedInput}` 或 `{behavior:'deny', message}`
- 网关内置 MCP stdio 服务（纯 JSON-RPC 手写，无需 SDK）：`initialize` / `tools/list`（一个
  `confirm_action` 工具）/ `tools/call`
- MCP 服务收到 `tools/call confirm_action` → 回环 POST 网关 permission 端点（共享 secret
  `ATBX_PERM_SECRET`）→ 网关转发抽屉 → 应答透传回 CC

**测试**：桥进程起 → 模拟 CC 调 tools/call → 断言 permission 卡流程（stub 抽屉应答）→ allow/deny 两路径。

- [x] **实现与测试 → `npm test` 全绿 → 提交**（2026-10-18 完成）。**机制选型决策（实测依据）**：CLI 的
  `--permission-prompt-tool` 是唯一的权限路由槽位——取值字面量 `stdio`（stream-json 控制通道，
  `control_request`/`control_response` 双向帧）或某个 `--mcp-config` 里的 MCP 工具名，**二者互斥**：
  claude 2.1.302 二进制与官方 SDK（@anthropic-ai/claude-agent-sdk 0.3.232）对同时配置直接报错
  `canUseTool callback cannot be used with permissionPromptToolName. Please use one or the other.`，
  且 SDK 的 canUseTool 回调正是用 `--permission-prompt-tool stdio` 实现的——控制通道即第一方机制。
  故**只实现控制通道路径**（进程内、零额外进程/临时 MCP 配置/共享密钥/新网关端点），MCP 桥
  （`cc-perm-bridge.mjs`）为同一槽位的冗余第二实现，**暂缓不做**（留此记录；若未来要在多机
  部署中把审批转发到远端网关再评估）。落地：`cc.mjs` full 级别加 `--input-format stream-json +
  --permission-prompt-tool stdio`，stdin 以 stream-json user 消息驱动回合且不关闭（供应答回写）；
  解析 `control_request(can_use_tool)` → `ctx.requestApproval(tool_name, summarizeToolInput(input))`
  → 回写 `{type:'control_response',response:{subtype:'success',request_id,response:{behavior:
  'allow',updatedInput}|{behavior:'deny',message},toolUseID}}`（形状对齐官方 SDK）；审批闸缺失
  fail-closed 拒绝；server.mjs 零改动（Task 9 的 requestApproval/toolTier/allowedTools 已全量注入）。
  测试：`test/cc-perm.test.mjs`（适配器 allow/deny/fail-closed + argv 回归 + 网关 SSE 往返）+
  `cc-stream.test.mjs`（帧解析/摘要/应答形状），夹具 `fake-claude-perm.mjs`、`cc-echo-argv.sh`。

---

### Task 12: acp request_permission 转发

**Files:**
- Modify: `packages/agent-server/src/adapters/acp.mjs`
- Test: `packages/agent-server/test/acp-adapter.test.mjs`

- [ ] 实现：`toolTier==='full'` 时 `requestPermission` 不再启发式，改为经 `ctx.requestApproval(action, summary)` 转发抽屉（ctx 由 server 注入 `confirm` 回调）；read 级别维持启发式（只读放行/其他拒绝）
- [ ] 测试：full tier 下写类工具 → confirm(true) → delta 流继续；confirm(false) → isError 结果。`npm test` 全绿
- [ ] 提交 `feat(agent-server): acp full-tier permission forwarding`

---

### Task 13: 前端权限卡

**Files:**
- Modify: `src/pages/free-models.astro`、`src/lib/agentchat.ts`、`src/lib/agentchat.test.ts`

- [ ] agentchat.ts：`ChatEvent` 增加 `{type:'permission_request'; reqId; action; summary}`；`answerPermission(sessionId, reqId, allow)` POST 帮助函数
- [ ] 抽屉：`permission_request` 事件 → 聊天区插入权限卡（动作 + 摘要 + 批准/拒绝按钮）→ 点击后 POST 应答并在卡上标记结果；超时（网关自动拒绝）时卡片置灰
- [ ] 测试：parseSSEChunk 解析 permission_request 帧；UI 手测截图
- [ ] 提交 `feat(site): permission card for tool approvals`

---

### Task 14: 发布 0.5.0 收尾

- [ ] README：期 2 能力（权限卡、cc MCP 桥、工具级别 full）文档化
- [ ] 全量回归：`npm test && npm run build && (cd packages/agent-server && npm test)`
- [ ] 版本 0.5.0 + tag `agent-server-v0.5.0` + push（OIDC 自动发布——Trusted Publisher 已配置生效）
- [ ] 合并 main 部署后线上冒烟：真实目录 + 完整工具 + 逐动作确认跑一个复杂任务（如“把这个文件里的 X 改成 Y 并运行测试”）

---

## Self-Review 记录

**Spec 覆盖**：期 1（cwd/tier 校验 T1、pi 只读工具 T2、pi 接入 T3、cc 分级 T4、acp 启发式 T5、配额 T6、前端 T7、发布 T8）✓；期 2（permission 中枢 T9、pi 写/执行 T10、cc MCP 桥 T11、acp 转发 T12、权限卡 T13、发布 T14）✓。

**已知实现风险**（实现时验证，非占位符）：
1. pi-ai `Tool.parameters` 对裸 JSON Schema 的接受度——Task 2 已内置冒烟验证要求
2. cc `--permission-prompt-tool` 的 MCP 协议细节——Task 11 用假 CC 驱动验证（已解决：路由槽位唯一且互斥，选 stdio 控制通道，MCP 桥暂缓——见 Task 11 决策记录）
3. acp 各 agent 的 `request_permission` options 形状差异——Task 5 夹具 + Task 12 真机验证

**类型一致性**：`toolTier`/`cwd`/`agent` 字段在 server/pi/cc/acp/前端间一致；`requestApproval(action, summary)` 签名统一。
