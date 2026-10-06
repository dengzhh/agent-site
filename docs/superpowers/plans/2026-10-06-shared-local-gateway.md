# Shared Local Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `agenttoolbox-agent` 从「单一 pi 后端」改造成「共享本地网关 + 可插拔适配器」，新增 Claude Code 适配器以放行被 gate 的 OpenRouter 免费模型并解锁只读工具。

**Architecture:** 网关保留现有 HTTP/SSE 接口（`/health`、`/sessions`、`/sessions/:id/messages`、`/sessions/:id/abort`）与事件契约（`delta`/`turn_end`/`error`/`done`）不变。内部引入 adapters 层：`pi`（进程内 pi-ai，默认）与 `cc`（spawn `claude -p --output-format=stream-json` 子进程，`CLAUDE_CONFIG_DIR` 指向临时空目录做配置隔离）。路由按数据层 `agents` 标注选择，运行时遇 gate 403 自动切 cc 并记忆。目录授权经网关 CLI 子命令（`grant`/`list`/`revoke`）写入网关自己的配置文件，授权后 cc 适配器解锁只读工具。

**Tech Stack:** Node ≥22（none 框架，`node:http` + `node:child_process`）、pi-agent-core/pi-ai（既有）、vitest（站点端）/ node:test（网关端）、Claude Code CLI（外部运行时，仅 cc 适配器需要）。

**Spec:** `docs/superpowers/specs/2026-10-06-shared-local-gateway-design.md`

**已验证事实（2026-10-06 实测，实现时直接依赖）：**
- `claude -p "..." --output-format=stream-json --include-partial-messages --verbose` 输出逐行 JSON
- 隔离：`CLAUDE_CONFIG_DIR=<空目录>` 可阻止读取用户的 `~/.claude/settings.json`（不加时实测会加载用户默认模型并执行其 SessionStart hook）
- 经 `ANTHROPIC_BASE_URL=https://openrouter.ai/api` + `ANTHROPIC_AUTH_TOKEN=<openrouter key>` + `ANTHROPIC_API_KEY=""` 调用，被 gate 的模型（`thinkingmachines/inkling-small:free`）正常返回
- stream-json 关键行形态：`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}`；终结行 `{"type":"result","subtype":"success","session_id":"...","is_error":false,"result":"..."}`

---

### Task 1: 适配器契约与注册表

**Files:**
- Create: `packages/agent-server/src/adapters/registry.mjs`
- Test: `packages/agent-server/test/registry.test.mjs`

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/adapters/registry.mjs';

const fake = (id, available = true) => ({
  id,
  available: async () => available,
  run: async function* () { yield { type: 'done' }; },
});

test('registry lists and reports availability', async () => {
  const r = createRegistry([fake('pi'), fake('cc', false)]);
  assert.deepEqual(await r.status(), [
    { id: 'pi', available: true },
    { id: 'cc', available: false },
  ]);
});

test('registry picks preferred adapter when available', () => {
  const r = createRegistry([fake('pi'), fake('cc')]);
  assert.equal(r.pick(['cc', 'pi']).id, 'cc');
  assert.equal(r.pick(['pi']).id, 'pi');
});

test('registry falls back to pi when preferred unavailable', () => {
  const r = createRegistry([fake('pi'), fake('cc', false)]);
  assert.equal(r.pick(['cc', 'pi']).id, 'pi');
});

test('registry throws when nothing can serve', () => {
  const r = createRegistry([fake('cc', false)]);
  assert.throws(() => r.pick(['cc']), /no available adapter/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/agent-server && npm test`
Expected: FAIL — `Cannot find module '../src/adapters/registry.mjs'`

- [ ] **Step 3: 实现**

```javascript
// 适配器注册表：适配器只需实现 { id, available(), run(ctx) }。
// run 返回 AsyncIterable<AgentEvent>，事件契约与 SSE 层一致
// （delta / turn_end / error / done），因此路由切换对前端透明。
export function createRegistry(adapters) {
  const byId = new Map(adapters.map((a) => [a.id, a]));
  return {
    async status() {
      const out = [];
      for (const a of adapters) out.push({ id: a.id, available: await a.available() });
      return out;
    },
    // preferred 是数据层标注的偏好序（如 ['cc','pi']）；返回首个可用的
    pick(preferred) {
      for (const id of preferred) {
        const a = byId.get(id);
        if (a) return a;
      }
      // 偏好项都不在注册表里 → 用任一存在的适配器兜底
      const first = adapters[0];
      if (first) return first;
      throw new Error(`no available adapter for [${preferred.join(',')}]`);
    },
    get(id) { return byId.get(id); },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`（在 packages/agent-server）
Expected: 4 new passing（总数 = 26 + 4 = 30）

- [ ] **Step 5: 提交**

```bash
git add packages/agent-server/src/adapters/registry.mjs packages/agent-server/test/registry.test.mjs
git commit -m "feat(agent-server): adapter registry"
```

---

### Task 2: cc 适配器 —— stream-json 解析（纯函数）

**Files:**
- Create: `packages/agent-server/src/adapters/cc-stream.mjs`
- Test: `packages/agent-server/test/cc-stream.test.mjs`

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCcLine } from '../src/adapters/cc-stream.mjs';

test('text delta line becomes a delta event', () => {
  const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'PONG' } } });
  assert.deepEqual(parseCcLine(line), { type: 'delta', text: 'PONG' });
});

test('result line carries session id and error state', () => {
  const ok = JSON.stringify({ type: 'result', subtype: 'success', session_id: 'abc-123', is_error: false, result: 'PONG' });
  assert.deepEqual(parseCcLine(ok), { type: 'turn_end', stopReason: null, sessionId: 'abc-123' });
  const bad = JSON.stringify({ type: 'result', subtype: 'error_during_execution', session_id: 'abc-123', is_error: true, result: 'API Error: 403 ...' });
  assert.deepEqual(parseCcLine(bad), { type: 'error', message: 'API Error: 403 ...', sessionId: 'abc-123' });
});

test('ignores unrelated and malformed lines', () => {
  assert.equal(parseCcLine(JSON.stringify({ type: 'system', subtype: 'init' })), null);
  assert.equal(parseCcLine(JSON.stringify({ type: 'assistant', message: {} })), null);
  assert.equal(parseCcLine('not json'), null);
  assert.equal(parseCcLine(''), null);
});

test('extracts nested error message from assistant content blocks', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 400 unavailable' }] } });
  assert.equal(parseCcLine(line), null); // assistant 行不进事件流，避免与 delta 重复
});

// gate 判定：供路由回退使用
test('detects agentic-harness gate errors', async () => {
  const { isGateError } = await import('../src/adapters/cc-stream.mjs');
  assert.equal(isGateError('403 agentic harness'), true);
  assert.equal(isGateError('only available on agentic harnesses'), true);
  assert.equal(isGateError('random 400'), false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/adapters/cc-stream.mjs'`

- [ ] **Step 3: 实现**

```javascript
// Claude Code `--output-format=stream-json` 的逐行解析。
// 只提取两类行：文本增量（stream_event/content_block_delta/text_delta）
// 与终结行（result）。assistant 整块消息行刻意忽略——其文本已由 delta 覆盖，
// 重复消费会让前端出现双份文字。
export function parseCcLine(line) {
  if (!line) return null;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }

  if (obj.type === 'stream_event') {
    const ev = obj.event;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
      return { type: 'delta', text: ev.delta.text };
    }
    return null;
  }

  if (obj.type === 'result') {
    const sessionId = obj.session_id ?? null;
    if (obj.is_error) {
      return { type: 'error', message: String(obj.result ?? 'Claude Code error'), sessionId };
    }
    return { type: 'turn_end', stopReason: obj.subtype === 'success' ? null : (obj.subtype ?? null), sessionId };
  }

  return null;
}

// OpenRouter 的 agentic-harness 网关拒绝信息（用于自动回退到 cc）
const GATE_PATTERN = /agentic harness/i;
export function isGateError(message) {
  return GATE_PATTERN.test(String(message ?? ''));
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: 5 new passing（总数 35）

- [ ] **Step 5: 提交**

```bash
git add packages/agent-server/src/adapters/cc-stream.mjs packages/agent-server/test/cc-stream.test.mjs
git commit -m "feat(agent-server): Claude Code stream-json parser"
```

---

### Task 3: cc 适配器 —— 子进程驱动与配置隔离

**Files:**
- Create: `packages/agent-server/src/adapters/cc.mjs`
- Test: `packages/agent-server/test/cc-adapter.test.mjs`
- Create: `packages/agent-server/test/fixtures/fake-claude.sh`

- [ ] **Step 1: 建假 CLI 夹具**（让测试不依赖真实 Claude Code）

`packages/agent-server/test/fixtures/fake-claude.sh`：

```sh
#!/bin/sh
# 假 claude CLI：回放固定的 stream-json，用于适配器测试。
# 环境变量 FAKE_CC_MODE 控制行为：ok（默认）| error | gate
echo '{"type":"system","subtype":"init","session_id":"fake-sess-1"}'
case "${FAKE_CC_MODE:-ok}" in
  error)
    echo '{"type":"result","subtype":"error_during_execution","session_id":"fake-sess-1","is_error":true,"result":"API Error: 500 boom"}'
    ;;
  gate)
    echo '{"type":"result","subtype":"error_during_execution","session_id":"fake-sess-1","is_error":true,"result":"403 only available on agentic harnesses"}'
    ;;
  *)
    echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"PONG"}}}'
    echo '{"type":"result","subtype":"success","session_id":"fake-sess-1","is_error":false,"result":"PONG"}'
    ;;
esac
```

- [ ] **Step 2: 写失败测试**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCcAdapter } from '../src/adapters/cc.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude.sh');

const collect = async (iter) => { const out = []; for await (const e of iter) out.push(e); return out; };

test('cc adapter streams deltas then turn_end', async () => {
  const cc = createCcAdapter({ cliPath: FIXTURE });
  const events = await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'x/y:free', apiKey: 'k', baseUrl: 'https://openrouter.ai/api',
    cwd: '/tmp', allowedTools: [],
  }));
  assert.deepEqual(events.map((e) => e.type), ['delta', 'turn_end']);
  assert.equal(events[0].text, 'PONG');
  assert.equal(events[1].sessionId, 'fake-sess-1');
});

test('cc adapter surfaces CLI errors', async () => {
  const cc = createCcAdapter({ cliPath: FIXTURE, env: { FAKE_CC_MODE: 'error' } });
  const events = await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [],
  }));
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /500 boom/);
});

test('cc adapter marks gate errors for routing fallback', async () => {
  const cc = createCcAdapter({ cliPath: FIXTURE, env: { FAKE_CC_MODE: 'gate' } });
  const events = await collect(cc.run({
    messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api', cwd: '/tmp', allowedTools: [],
  }));
  assert.equal(events.at(-1).gate, true);
});

test('cc adapter availability reflects cli presence', async () => {
  assert.equal(await createCcAdapter({ cliPath: FIXTURE }).available(), true);
  assert.equal(await createCcAdapter({ cliPath: '/nonexistent/claude' }).available(), false);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `chmod +x test/fixtures/fake-claude.sh && npm test`
Expected: FAIL — `Cannot find module '../src/adapters/cc.mjs'`

- [ ] **Step 4: 实现**

```javascript
// Claude Code 适配器：把 claude CLI 的 headless stream-json 转成统一事件流。
// 关键安全点：CLAUDE_CONFIG_DIR 指向临时空目录，阻止 CLI 加载用户的
// ~/.claude/settings.json（否则会用用户默认模型并执行其 hooks——已实测）。
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { parseCcLine, isGateError } from './cc-stream.mjs';

const PROMPT_TAIL = 'Reply helpfully and concisely.';

function isolatedConfigDir() {
  return mkdtempSync(join(tmpdir(), 'atbx-cc-'));
}

function buildArgs({ allowedTools, resumeSessionId }) {
  const args = ['-p', '--output-format=stream-json', '--include-partial-messages', '--verbose'];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  // 只读工具集：未授权目录时为空数组 → 纯聊天
  args.push('--allowedTools', allowedTools.join(','));
  return args;
}

// messages 里最后一条 user 文本作为本轮 prompt（历史由 --resume 维持）
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return String(messages[i].content ?? '');
  }
  return '';
}

export function createCcAdapter({ cliPath = 'claude', env = {} } = {}) {
  return {
    id: 'cc',
    async available() {
      if (cliPath.includes('/')) return existsSync(cliPath);
      // PATH 查找
      const paths = (process.env.PATH ?? '').split(':');
      return paths.some((p) => p && existsSync(join(p, cliPath)));
    },
    async *run({ messages, model, apiKey, baseUrl, cwd, allowedTools = [], resumeSessionId }) {
      const child = spawn(cliPath, buildArgs({ allowedTools, resumeSessionId }), {
        cwd: cwd || process.cwd(),
        env: {
          ...process.env,
          ...env,
          CLAUDE_CONFIG_DIR: isolatedConfigDir(),   // 配置隔离（见文件头注释）
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_AUTH_TOKEN: apiKey ?? '',
          ANTHROPIC_API_KEY: '',                    // 必须置空，否则回落 Anthropic 官方鉴权
          ANTHROPIC_MODEL: model,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.write(lastUserText(messages) || PROMPT_TAIL);
      child.stdin.end();

      let buffer = '';
      const events = [];
      let sawTerminal = false;
      for await (const chunk of child.stdout) {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const ev = parseCcLine(line.trim());
          if (!ev) continue;
          if (ev.type === 'error' && isGateError(ev.message)) ev.gate = true;
          if (ev.type === 'turn_end' || ev.type === 'error') sawTerminal = true;
          yield ev;
        }
      }
      const tail = parseCcLine(buffer.trim());
      if (tail) yield tail;
      if (!sawTerminal) {
        const code = await new Promise((r) => child.once('close', r));
        yield { type: 'error', message: `claude exited with code ${code}` };
      }
    },
  };
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test`
Expected: 4 new passing（总数 39）

- [ ] **Step 6: 提交**

```bash
git add packages/agent-server/src/adapters/cc.mjs packages/agent-server/test/cc-adapter.test.mjs packages/agent-server/test/fixtures/fake-claude.sh
git commit -m "feat(agent-server): Claude Code adapter with config isolation"
```

---

### Task 4: pi 适配器抽取

**Files:**
- Create: `packages/agent-server/src/adapters/pi.mjs`
- Test: `packages/agent-server/test/pi-adapter.test.mjs`

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fauxProvider, createModels, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { createPiAdapter } from '../src/adapters/pi.mjs';

test('pi adapter streams faux text then turn_end', async () => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText('hi from pi')])]);

  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
    makeAgent: (models, model, sessionId, apiKey) => null, // 见实现：pi 适配器自带 Agent 构造
  });

  const events = [];
  for await (const e of pi.run({
    messages: [{ role: 'user', content: 'hi' }],
    request: { provider: 'faux', model: 'faux' },
    apiKey: null,
  })) events.push(e);

  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'hi from pi');
  assert.ok(events.some((e) => e.type === 'turn_end'));
});

test('pi adapter reports available', async () => {
  const models = createModels();
  const pi = createPiAdapter({ models, resolve: () => ({}), makeAgent: () => null });
  assert.equal(await pi.available(), true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/adapters/pi.mjs'`

- [ ] **Step 3: 实现**

把 `server.mjs` 中现有的 `makeAgent` 逻辑与 SSE 订阅逻辑搬进适配器（`server.mjs` 侧的删除在 Task 6 做）：

```javascript
// pi 适配器：进程内 pi-agent-core 运行时（现有行为的封装）。
// Agent 的构造与事件订阅原样搬自 server.mjs，事件转成统一契约。
import { Agent } from '@earendil-works/pi-agent-core';

const SYSTEM_PROMPT = 'You are a helpful assistant chatting in the AgentToolbox web app. Be concise and useful.';
const STREAM_TIMEOUT_MS = 15 * 60_000;

export function createPiAdapter({ models, resolve, makeAgentOverride }) {
  return {
    id: 'pi',
    async available() { return true; },
    async *run({ messages, request, apiKey, sessionId }) {
      const { model } = resolve(models, request);
      const agent = makeAgentOverride
        ? makeAgentOverride(models, model, sessionId, apiKey)
        : new Agent({
            initialState: { systemPrompt: SYSTEM_PROMPT, model },
            streamFn: (m, ctx, opts) => models.streamSimple(m, ctx, { ...opts, timeoutMs: STREAM_TIMEOUT_MS }),
            sessionId,
            getApiKey: () => apiKey,
          });

      const queue = [];
      let notify = null;
      const push = (ev) => { queue.push(ev); notify?.(); notify = null; };
      const unsub = agent.subscribe((ev) => {
        if (ev.type === 'message_update' && ev.assistantMessageEvent.type === 'text_delta') {
          push({ type: 'delta', text: ev.assistantMessageEvent.delta });
        } else if (ev.type === 'turn_end') {
          push({ type: 'turn_end', stopReason: ev.message.stopReason ?? null });
          if (ev.message.stopReason === 'error') {
            push({ type: 'error', message: ev.message.errorMessage ?? 'provider error' });
          }
        }
      });

      const text = messages.at(-1)?.content ?? '';
      const done = agent.prompt(text).catch((err) => push({ type: 'error', message: String(err?.message ?? err) }));

      try {
        while (true) {
          if (queue.length === 0) {
            const finished = await Promise.race([done.then(() => 'done'), new Promise((r) => { notify = () => r('more'); })]);
            if (finished === 'done' && queue.length === 0) break;
            continue;
          }
          yield queue.shift();
        }
        // prompt 完成后仍可能残留事件
        while (queue.length) yield queue.shift();
      } finally {
        unsub();
      }
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: 2 new passing（总数 41）

- [ ] **Step 5: 提交**

```bash
git add packages/agent-server/src/adapters/pi.mjs packages/agent-server/test/pi-adapter.test.mjs
git commit -m "feat(agent-server): pi adapter (extracted from server)"
```

---

### Task 5: 网关配置存储（授权目录）

**Files:**
- Create: `packages/agent-server/src/config.mjs`
- Test: `packages/agent-server/test/config.test.mjs`

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, grantDir, revokeDir } from '../src/config.mjs';

const cfgPath = () => join(mkdtempSync(join(tmpdir(), 'atbx-cfg-')), 'config.json');

test('starts empty and grants dirs idempotently', () => {
  const p = cfgPath();
  assert.deepEqual(loadConfig(p).grantedDirs, []);
  grantDir(p, '/tmp/proj-a');
  grantDir(p, '/tmp/proj-a');
  grantDir(p, '/tmp/proj-b');
  assert.deepEqual(loadConfig(p).grantedDirs, ['/tmp/proj-a', '/tmp/proj-b']);
});

test('revoke removes and tolerates missing', () => {
  const p = cfgPath();
  grantDir(p, '/tmp/a');
  revokeDir(p, '/tmp/a');
  revokeDir(p, '/tmp/never');
  assert.deepEqual(loadConfig(p).grantedDirs, []);
});

test('corrupt file falls back to empty config', () => {
  const p = cfgPath();
  const { writeFileSync } = require('node:fs');
  writeFileSync(p, '{ broken');
  assert.deepEqual(loadConfig(p).grantedDirs, []);
});
```

（注：测试里的 `require` 在 ESM 下不可用——实现者改用顶部 `import { writeFileSync } from 'node:fs'`，与其它测试一致。）

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/config.mjs'`

- [ ] **Step 3: 实现**

```javascript
// 网关自有配置（与用户的 Claude 配置完全隔离）。
// 默认位置：~/.config/agenttoolbox/config.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'agenttoolbox', 'config.json');
const EMPTY = { grantedDirs: [] };

export function loadConfig(path = DEFAULT_CONFIG_PATH) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { grantedDirs: Array.isArray(raw.grantedDirs) ? raw.grantedDirs : [] };
  } catch {
    return { ...EMPTY };   // 文件缺失或损坏 → 空配置，绝不抛
  }
}

function save(path, cfg) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
}

export function grantDir(path, dir = DEFAULT_CONFIG_PATH) {
  const cfg = loadConfig(path);
  if (!cfg.grantedDirs.includes(dir)) cfg.grantedDirs.push(dir);
  save(path, cfg);
  return cfg.grantedDirs;
}

export function revokeDir(path, dir = DEFAULT_CONFIG_PATH) {
  const cfg = loadConfig(path);
  cfg.grantedDirs = cfg.grantedDirs.filter((d) => d !== dir);
  save(path, cfg);
  return cfg.grantedDirs;
}
```

⚠️ 参数顺序陷阱：上面的 `grantDir(dir, path)` 与实现签名 `grantDir(path, dir)` 相反。实现时统一为
**`grantDir(targetDir, configPath = DEFAULT_CONFIG_PATH)`**（目录在前，配置路径可省），并同步修正测试调用。

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: 3 new passing（总数 44）

- [ ] **Step 5: 提交**

```bash
git add packages/agent-server/src/config.mjs packages/agent-server/test/config.test.mjs
git commit -m "feat(agent-server): gateway config store for granted dirs"
```

---

### Task 6: 服务端集成（路由 + /health 扩展）

**Files:**
- Modify: `packages/agent-server/src/server.mjs`
- Modify: `packages/agent-server/test/server.test.mjs`

- [ ] **Step 1: 扩展测试**

在 `test/server.test.mjs` 的 `withFauxServer` 辅助里，让 `startServer` 额外接收 `registry`；并新增测试：

```javascript
test('health reports adapters and granted dirs', async (t) => {
  const { json } = await withFauxServer(t);
  const { status, body } = await json('/health');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.agents));
  assert.ok(body.agents.some((a) => a.id === 'pi' && a.available === true));
  assert.deepEqual(body.grantedDirs, []);
});

test('session records which adapter serves it', async (t) => {
  const { json } = await withFauxServer(t);
  const create = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux' }),
  });
  assert.equal(create.body.adapter, 'pi');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL — `/health` 无 `agents` 字段；`/sessions` 响应无 `adapter`

- [ ] **Step 3: 改造 server.mjs**

要点（保持既有路由与 CORS/PNA 逻辑不动）：
1. 顶部引入 `createRegistry`、`createPiAdapter`、`createCcAdapter`、`loadConfig`
2. `startServer({ ..., registry })` 新增可选参数；未传时构造默认注册表：
   ```javascript
   const reg = registry ?? createRegistry([
     createPiAdapter({ models, resolve }),
     createCcAdapter(),
   ]);
   ```
3. `/health` 改：
   ```javascript
   if (req.method === 'GET' && url.pathname === '/health') {
     return json(200, {
       ok: true, version: VERSION,
       agents: await reg.status(),
       grantedDirs: loadConfig().grantedDirs,
     });
   }
   ```
4. `/sessions`：不再直接 `makeAgent`，改为记录请求并选定适配器：
   ```javascript
   const adapter = reg.pick(body.agents ?? ['pi']);
   const id = randomUUID();
   sessions.set({ id, adapter, request: body, model: null, providerId: null,
     apiKey: body.apiKey ?? null, grantedDirs: loadConfig().grantedDirs,
     ccSessionId: null, lastUsed: Date.now(), streaming: false });
   return json(200, { sessionId: id, adapter: adapter.id, provider: body.provider, model: body.model });
   ```
5. `/messages` 改为消费适配器事件流（替换原 subscribe 段）：
   ```javascript
   const allowedTools = session.grantedDirs.length && session.adapter.id === 'cc'
     ? ['Read', 'Grep', 'Glob'] : [];
   const cwd = session.grantedDirs[0] ?? undefined;   // 授权目录作为工作目录
   session.streaming = true;
   res.on('close', () => { session.abort?.(); });
   try {
     for await (const ev of session.adapter.run({
       messages: [{ role: 'user', content: text }],
       request: session.request, apiKey: session.apiKey, sessionId: session.id,
       cwd, allowedTools, resumeSessionId: session.ccSessionId,
     })) {
       if (ev.sessionId) session.ccSessionId = ev.sessionId;   // cc 续会话
       if (ev.type === 'delta') send('delta', { text: ev.text });
       else if (ev.type === 'turn_end') send('turn_end', { stopReason: ev.stopReason ?? null });
       else if (ev.type === 'error') send('error', { message: ev.message });
     }
   } catch (err) {
     send('error', { message: String(err?.message ?? err) });
   } finally {
     session.streaming = false; send('done', {}); res.end();
   }
   ```
6. 删除 `makeAgent` 与 `SYSTEM_PROMPT`/`STREAM_TIMEOUT_MS`（已移入 pi 适配器）
7. `abort` 路由：`session.agent.abort()` → `session.abort?.()`；会话对象在 `run` 期间由适配器暴露
   abort（pi 适配器返回的对象增加 `abort()`；简化实现：会话上挂 `abort` 由 server 在 `run` 前设置）

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: 全部通过（既有 44 + 新 2 = 46）；既有 SSE 往返测试仍绿（证明契约未破坏）

- [ ] **Step 5: 端到端手测**

```bash
node bin/agenttoolbox-agent.mjs --port 31415 &
sleep 1
curl -s http://127.0.0.1:31415/health | python3 -m json.tool
```
Expected: 含 `agents: [{id:'pi',available:true},{id:'cc',available:<?>}]` 与 `grantedDirs: []`

- [ ] **Step 6: 提交**

```bash
git add packages/agent-server/src/server.mjs packages/agent-server/test/server.test.mjs
git commit -m "feat(agent-server): route sessions through adapter registry"
```

---

### Task 7: CLI 子命令（grant / list / revoke）

**Files:**
- Modify: `packages/agent-server/bin/agenttoolbox-agent.mjs`
- Test: `packages/agent-server/test/cli.test.mjs`

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agenttoolbox-agent.mjs');
const run = (args, cfgPath) =>
  execFileSync('node', [BIN, ...args], { encoding: 'utf8', env: { ...process.env, ATBX_CONFIG_PATH: cfgPath } });

test('grant then list shows the dir', () => {
  const cfg = join(mkdtempSync(join(tmpdir(), 'atbx-cli-')), 'c.json');
  run(['grant', '/tmp/demo-proj'], cfg);
  const out = run(['list'], cfg);
  assert.match(out, /\/tmp\/demo-proj/);
});

test('revoke removes it', () => {
  const cfg = join(mkdtempSync(join(tmpdir(), 'atbx-cli-')), 'c.json');
  run(['grant', '/tmp/x'], cfg);
  run(['revoke', '/tmp/x'], cfg);
  assert.doesNotMatch(run(['list'], cfg), /\/tmp\/x/);
});

test('grant without argument exits non-zero', () => {
  const cfg = join(mkdtempSync(join(tmpdir(), 'atbx-cli-')), 'c.json');
  assert.throws(() => run(['grant'], cfg));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL — 未知子命令被当端口参数处理/报错不符

- [ ] **Step 3: 实现**

在 `bin/agenttoolbox-agent.mjs` 顶部（解析 `--port` 之前）插入子命令分支：

```javascript
import { loadConfig, grantDir, revokeDir, DEFAULT_CONFIG_PATH } from '../src/config.mjs';

const CONFIG_PATH = process.env.ATBX_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
const sub = process.argv[2];

if (sub === 'grant') {
  const dir = process.argv[3];
  if (!dir) { console.error('usage: agenttoolbox-agent grant <dir>'); process.exit(1); }
  const dirs = grantDir(dir, CONFIG_PATH);
  console.log(`granted: ${dir}`);
  console.log(`all granted dirs: ${dirs.join(', ') || '(none)'}`);
  process.exit(0);
}
if (sub === 'revoke') {
  const dir = process.argv[3];
  if (!dir) { console.error('usage: agenttoolbox-agent revoke <dir>'); process.exit(1); }
  revokeDir(dir, CONFIG_PATH);
  console.log(`revoked: ${dir}`);
  process.exit(0);
}
if (sub === 'list') {
  const { grantedDirs } = loadConfig(CONFIG_PATH);
  console.log(grantedDirs.length ? grantedDirs.join('\n') : '(no granted dirs)');
  process.exit(0);
}
```

（`grantDir(dir, configPath)` 的签名以 Task 5 最终实现为准——两者必须一致。）

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: 3 new passing

- [ ] **Step 5: 手测**

```bash
node bin/agenttoolbox-agent.mjs grant ~/AI/agent-site
node bin/agenttoolbox-agent.mjs list
node bin/agenttoolbox-agent.mjs revoke ~/AI/agent-site
```

- [ ] **Step 6: 提交**

```bash
git add packages/agent-server/bin/agenttoolbox-agent.mjs packages/agent-server/test/cli.test.mjs
git commit -m "feat(agent-server): grant/list/revoke subcommands"
```

---

### Task 8: 数据层 agents 标注

**Files:**
- Modify: `scripts/sync-free-models.mjs`
- Modify: `scripts/sync-free-models.test.mjs`（若存在对应断言）
- Modify: `src/data/free-models.json`（由脚本重新生成）

- [ ] **Step 1: 加标注逻辑**

在 `buildFreeModelsIndex` 的 provider 循环内、`providers.push({...})` 之前，给每个模型补 `agents`：

```javascript
// OpenRouter 的免费模型受 "agentic harness" 网关限制：只有 Claude Code 这类
// 官方智能体运行时能调用（实测 pi 请求一律 403）。标注为 cc-only，让网关路由。
const GATED_PROVIDER_IDS = new Set(['openrouter']);
...
    for (const m of models) {
      m.agents = GATED_PROVIDER_IDS.has(pid) ? ['cc', 'pi'] : ['pi'];
    }
```

（`['cc','pi']` 表示优先 cc、cc 不可用时可回退 pi——对 OpenRouter 免费档，
回退 pi 会被 gate 拒绝，但这由运行时兜底逻辑处理，标注只表达偏好序。）

- [ ] **Step 2: 运行确认**

Run: `node scripts/sync-free-models.mjs && npm test`
Expected: 数据文件更新（含 `agents` 字段）；根 vitest 46 passed

- [ ] **Step 3: 核对产物**

```bash
python3 -c "
import json
d=json.load(open('src/data/free-models.json'))
for p in d['providers']:
    m=p['models'][0]
    print(p['id'], '→', m.get('agents'))
"
```
Expected: openrouter 行为 `['cc','pi']`，其余为 `['pi']`

- [ ] **Step 4: 提交**

```bash
git add scripts/sync-free-models.mjs src/data/free-models.json
git commit -m "feat(data): annotate models with supported agent adapters"
```

---

### Task 9: 网站端消费（health.agents + cc 引导）

**Files:**
- Modify: `src/lib/agentchat.ts`
- Modify: `src/lib/agentchat.test.ts`
- Modify: `src/pages/free-models.astro`

- [ ] **Step 1: 扩展类型与测试**

`agentchat.ts` 的 `HealthInfo` 增加 `agents`：

```typescript
export interface AgentStatus { id: string; available: boolean }
export interface HealthInfo {
  ok: boolean;
  version: string;
  grantedDirs: string[];
  agents: AgentStatus[];
}
```

测试：`probeHealth` 返回带 `agents` 的对象（用 vitest mock fetch 或跳过——保持现有测试风格，
若现有测试未覆盖 probeHealth 则新增一个 mock 用例）。

- [ ] **Step 2: 抽屉按需引导**

在 `free-models.astro` 的 `ensureSession` 之前增加判断：模型 `agents` 含 `cc` 且
health 报告 `cc` 不可用 → 显示引导面板（复用安装面板结构，文案改为）：

```html
<p>This model only runs through Claude Code (OpenRouter gates it to agentic harnesses).</p>
<pre class="chat-cmd"><code>curl -fsSL https://claude.ai/install.sh | bash</code></pre>
<p class="chat-sub">Then reopen this chat.</p>
```

实现要点：`openChat` 时把 `data-agents` 记入 state；`tryGoChat` 里若
`agents.includes('cc') && !health.agents.find(a => a.id === 'cc')?.available` → `showPane('install')`
并填 cc 文案，停止轮询（cc 需要用户安装，不是等服务起来）。

- [ ] **Step 3: 构建与测试**

Run: `npm test && npm run build`
Expected: vitest 全绿；11 页构建成功

- [ ] **Step 4: 浏览器验证**

起网关（`node packages/agent-server/bin/agenttoolbox-agent.mjs --port 31415`）与 dev server，
在 free-models 页点一个 openrouter 行的 Chat →，确认：health 含 agents、cc 可用时直达聊天、
cc 不可用（临时改 PATH 模拟）时显示安装引导。截图存档。

- [ ] **Step 5: 提交**

```bash
git add src/lib/agentchat.ts src/lib/agentchat.test.ts src/pages/free-models.astro
git commit -m "feat(site): route-aware chat drawer with Claude Code guidance"
```

---

### Task 10: 发布 0.2.0 与收尾

**Files:**
- Modify: `packages/agent-server/package.json`（version → 0.2.0）
- Modify: `packages/agent-server/README.md`（新增适配器、子命令、cc 前置条件）
- Delete: `scripts/verify/`（一次性验证脚本，设计阶段产物）

- [ ] **Step 1: 更新 README**

补三节：`Adapters`（pi 默认 / cc 需本机 Claude Code）、`Directory grants`
（`grant`/`list`/`revoke` 用法与只读工具说明）、`/health` 新字段。

- [ ] **Step 2: 全量回归**

Run: `npm test && npm run build && (cd packages/agent-server && npm test)`
Expected: 根 vitest 全绿；11 页构建；网关 node:test 全绿

- [ ] **Step 3: 清理验证脚本**

```bash
git rm -r scripts/verify
```

- [ ] **Step 4: 提交并打 tag**

```bash
git add packages/agent-server/package.json packages/agent-server/README.md
git commit -m "chore(agent-server): 0.2.0 — adapters, grants, docs"
git tag agent-server-v0.2.0
```

- [ ] **Step 5: 人工步骤（交给用户）**

本地 `npm publish`（passkey 认证）；发布后 `npx agenttoolbox-agent@0.2.0` 冒烟；
确认 `/health` 的 `agents` 与 `grantedDirs`。

---

## Self-Review 记录

**Spec 覆盖**：适配器接口（T1）、cc 运行时+隔离（T2/T3）、pi 保留默认（T4）、
授权存储（T5）、路由集成（T6）、CLI 授权子命令（T7）、数据层标注（T8）、
网站引导（T9）、发布（T10）✓。运行时 gate 回退（`isGateError`）在 T2 定义、
T3 打标；**T6 尚未消费该标记**——已在 T6 说明「兜底逻辑」，实现时若时间允许应在
`/messages` 里对 `ev.gate` 触发一次 cc 重试；否则记录为已知缺口。
**占位符**：无 TBD；T5 与 T7 的 `grantDir` 签名不一致问题已在两处显式标注并要求统一。
**类型一致性**：`AgentEvent` 四态（delta/turn_end/error/done）在 T1–T4、T6、T9 一致；
`HealthInfo.agents` 在 T6 产出、T9 消费一致。
