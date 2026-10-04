# Pi-Agent Chat Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** free-models 页每行一键 Chat，与所选免费模型流式对话：网站抽屉 UI + 本地 `npx agenttoolbox-agent` 薄后端（pi-agent-core 运行时，BYOK）。

**Architecture:** 网站静态（GitHub Pages）负责 UI/key/安装引导；新 npm workspace `packages/agent-server` 只监听 127.0.0.1:31415，提供 health/sessions/messages(SSE)/abort 四个 HTTP 接口，内部用 pi-ai 解析 provider（内置工厂优先，OpenAI 兼容动态回退）、pi-agent-core 跑 agent 循环。会话与 key 均内存态。

**Tech Stack:** Astro（现有站）、node:http + SSE（零 Web 框架）、@earendil-works/pi-ai@^1.0.2、@earendil-works/pi-agent-core@^1.0.2、node:test（后端测试）、vitest（网站端测试）。

**Spec:** `docs/superpowers/specs/2026-10-04-pi-agent-chat-design.md`

**已验证的 API 事实**（实现时直接依赖，勿再猜）：
- `import { Agent } from '@earendil-works/pi-agent-core'`；`new Agent({ initialState: { systemPrompt, model }, streamFn: models.streamSimple.bind(models), sessionId, getApiKey })`
- 事件：`agent.subscribe(ev => ...)`；`ev.type === 'message_update' && ev.assistantMessageEvent.type === 'text_delta'` 时取 `ev.assistantMessageEvent.delta`；`turn_end` 时 `ev.message.stopReason`
- `await agent.prompt(text)` / `agent.abort()` / `agent.state.messages`
- `import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai'`
- provider 工厂（`@earendil-works/pi-ai/providers/<file>`，返回对象含 `.id`）：`openrouterProvider`、`groqProvider`、`mistralProvider`、`cerebrasProvider`、`nvidiaProvider`、`togetherProvider`、`fireworksProvider`、`cloudflareWorkersAIProvider`、`opencodeProvider`、`zaiProvider`、`qwenTokenPlanProvider`
- 动态 OpenAI 兼容：`import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'` + `createProvider({ id, baseUrl, auth, models, api: openAICompletionsApi() })`
- keyless auth（opencode 等）：`auth: { apiKey: { name: 'X', resolve: async () => ({ auth: {} }) } }`
- 测试用 faux：`import { fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai'`；`faux.getModel()`、`faux.setResponses([fauxAssistantMessage([fauxText('...')])])`
- free-models.json provider id → pi-ai 工厂映射中 `togetherai→togetherProvider`、`fireworks-ai→fireworksProvider`、`alibaba-token-plan→qwenTokenPlanProvider`（用工厂返回的 `.id` 做 getModel，无需手写别名表）；`github-copilot`（OAuth）和 `deepinfra` 无工厂，前者前端不出 Chat 按钮、后者走动态回退

---

### Task 1: workspace 脚手架（不影响现有站）

**Files:**
- Modify: `package.json`（根）
- Create: `packages/agent-server/package.json`、`packages/agent-server/README.md`、`vitest.config.ts`（根）
- Modify: `package-lock.json`（npm install 自动）

- [ ] **Step 1: 根 package.json 加 workspaces 与 private**

`package.json` 增加两个顶层字段（其余不动）：

```json
  "private": true,
  "workspaces": ["packages/*"],
```

- [ ] **Step 2: 建 vitest.config.ts，把测试范围钉在 src/scripts（防止 vitest 扫到 workspace 的 node:test 文件）**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.*', 'scripts/**/*.test.*'],
  },
});
```

- [ ] **Step 3: 建 packages/agent-server/package.json**

```json
{
  "name": "agenttoolbox-agent",
  "version": "0.1.0",
  "description": "Local agent bridge for AgentToolbox: pi-agent chat sessions for the free-models page, BYOK, loopback only",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22.12.0" },
  "bin": { "agenttoolbox-agent": "bin/agenttoolbox-agent.mjs" },
  "files": ["bin", "src", "README.md"],
  "scripts": { "test": "node --test test/" },
  "dependencies": {
    "@earendil-works/pi-agent-core": "^1.0.2",
    "@earendil-works/pi-ai": "^1.0.2"
  }
}
```

- [ ] **Step 4: 占位 README.md**

```markdown
# agenttoolbox-agent

Local agent bridge for [AgentToolbox](https://dengzhh.github.io/agent-site/).

Run:

    npx agenttoolbox-agent@latest

Starts a loopback-only (127.0.0.1:31415) HTTP service that powers the Chat
drawer on the free-models page. Bring your own API keys — they stay in
memory and are sent only to the model provider you choose.

- `GET /health` — liveness + version
- `POST /sessions` — `{provider, model, baseUrl?, apiKey?, envKey?, name?, contextWindow?, maxOutput?}`
- `POST /sessions/:id/messages` — `{text}` → SSE stream (`delta`/`turn_end`/`error`/`done`)
- `POST /sessions/:id/abort`

Options: `--port <n>` / `PORT` env (default 31415); `AGENT_ALLOWED_ORIGINS`
(comma-separated extra CORS origins, e.g. `http://localhost:4321` for dev).

Node >= 22.12. MIT.
```

- [ ] **Step 5: 安装并验证站点无回归**

Run: `npm install && npm test && npm run build`
Expected: lockfile 更新；42+ tests passed（原 42 个）；`11 page(s) built`。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts packages/agent-server
git commit -m "chore: agent-server workspace scaffold"
```

---

### Task 2: SSE 编码（后端）模块

**Files:**
- Create: `packages/agent-server/src/sse.mjs`
- Test: `packages/agent-server/test/sse.test.mjs`

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSSE } from '../src/sse.mjs';

test('encodeSSE wraps JSON payload in data block', () => {
  assert.equal(encodeSSE('delta', { text: 'hi\nthere' }), `data: {"type":"delta","text":"hi\\nthere"}\n\n`);
});

test('encodeSSE comment heartbeat', () => {
  assert.equal(encodeSSE(null, null), ': ping\n\n');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/agent-server && npm test`
Expected: FAIL — `Cannot find module '../src/sse.mjs'`

- [ ] **Step 3: 实现**

```javascript
// SSE 帧：事件即一行 data: JSON。type 为 null 时输出注释心跳。
export function encodeSSE(type, payload) {
  if (type === null) return ': ping\n\n';
  return `data: ${JSON.stringify({ type, ...payload })}\n\n`;
}
```

- [ ] **Step 4: 跑测试通过**

Run: `npm test`
Expected: 2 passing。

- [ ] **Step 5: Commit**

```bash
git add packages/agent-server/src/sse.mjs packages/agent-server/test/sse.test.mjs
git commit -m "feat(agent-server): SSE encoder"
```

---

### Task 3: provider 解析模块（内置工厂 + 动态 OpenAI 兼容回退）

**Files:**
- Create: `packages/agent-server/src/providers.mjs`
- Test: `packages/agent-server/test/providers.test.mjs`

解析规则（spec）：① 命中内置工厂且 `getModel(工厂.id, modelId)` 存在且（请求无 baseUrl 或 `found.baseUrl === baseUrl`）→ 用内置；② 否则有 baseUrl → 动态 `createProvider`（OpenAI 兼容，免费价 cost 全 0，contextWindow/maxTokens 来自请求）；③ 都不行 → 抛 `UnsupportedError`。

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { resolveModel, UnsupportedError } from '../src/providers.mjs';

// groq 是内置 provider：目录命中且无 baseUrl → 内置模型
test('builtin provider hit returns catalog model', () => {
  const models = createModels();
  const r = resolveModel(models, { provider: 'groq', model: 'llama-3.3-70b-versatile' });
  assert.equal(r.model.provider, 'groq');
  assert.equal(r.model.id, 'llama-3.3-70b-versatile');
});

// baseUrl 与目录不一致（如 zai 免费档走 paas 端点而非 coding 端点）→ 动态回退
test('baseUrl mismatch falls back to dynamic provider', () => {
  const models = createModels();
  const r = resolveModel(models, {
    provider: 'zai', model: 'glm-5.3-flash',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    envKey: 'ZHIPU_API_KEY', name: 'GLM 5.3 Flash',
    contextWindow: 128000, maxOutput: 8192,
  });
  assert.equal(r.model.api, 'openai-completions');
  assert.equal(r.model.baseUrl, 'https://api.z.ai/api/paas/v4');
  assert.equal(r.model.contextWindow, 128000);
});

// 无工厂且无 baseUrl（deepinfra 漏传 baseUrl 的场景）→ UnsupportedError
test('unknown provider without baseUrl throws UnsupportedError', () => {
  const models = createModels();
  assert.throws(() => resolveModel(models, { provider: 'deepinfra', model: 'x' }), UnsupportedError);
});

// keyless：无 envKey 无 apiKey 也能建动态 provider（opencode zen 场景）
test('keyless dynamic provider resolves', () => {
  const models = createModels();
  const r = resolveModel(models, {
    provider: 'opencode', model: 'mimo-v2-pro-free',
    baseUrl: 'https://opencode.net/v1', name: 'MiMo',
    contextWindow: 200000, maxOutput: 8192,
  });
  assert.equal(r.model.provider, 'atbx-opencode');
});

// faux 冒烟：解析出的模型能进 Agent（本测试只验证 model 对象形状可被 getModel 找回）
test('dynamic model registered under its provider id', () => {
  const models = createModels();
  resolveModel(models, {
    provider: 'opencode', model: 'm1', baseUrl: 'https://x.test/v1',
    contextWindow: 1000, maxOutput: 100,
  });
  assert.ok(models.getModel('atbx-opencode', 'm1'));
});
```

注：groq 内置测试依赖目录里存在 `llama-3.3-70b-versatile`；若实际目录不同，先跑 Step 3 后用
`node -e "..."` 查一次真实 id 再回填测试（实现者自查，不改断言语义）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/providers.mjs'`

- [ ] **Step 3: 实现**

```javascript
// free-models.json provider id → pi-ai 内置工厂。github-copilot（OAuth）与
// deepinfra（无工厂）不在此表：前者前端不出 Chat 按钮，后者走动态回退。
import {
  createProvider, envApiKeyAuth,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { groqProvider } from '@earendil-works/pi-ai/providers/groq';
import { mistralProvider } from '@earendil-works/pi-ai/providers/mistral';
import { cerebrasProvider } from '@earendil-works/pi-ai/providers/cerebras';
import { nvidiaProvider } from '@earendil-works/pi-ai/providers/nvidia';
import { togetherProvider } from '@earendil-works/pi-ai/providers/together';
import { fireworksProvider } from '@earendil-works/pi-ai/providers/fireworks';
import { cloudflareWorkersAIProvider } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai';
import { opencodeProvider } from '@earendil-works/pi-ai/providers/opencode';
import { zaiProvider } from '@earendil-works/pi-ai/providers/zai';
import { qwenTokenPlanProvider } from '@earendil-works/pi-ai/providers/qwen-token-plan';

export const BUILTIN_FACTORIES = {
  openrouter: openrouterProvider,
  nvidia: nvidiaProvider,
  groq: groqProvider,
  mistral: mistralProvider,
  cerebras: cerebrasProvider,
  zai: zaiProvider,
  opencode: opencodeProvider,
  'cloudflare-workers-ai': cloudflareWorkersAIProvider,
  togetherai: togetherProvider,
  'fireworks-ai': fireworksProvider,
  'alibaba-token-plan': qwenTokenPlanProvider,
};

export class UnsupportedError extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedError'; }
}

const sanitize = (id) => id.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

/**
 * 解析 free-models 页发来的 {provider, model, baseUrl?, envKey?, name?,
 * contextWindow?, maxOutput?, apiKey?} 为 pi-ai Model，注册进 models 集合。
 * 返回 { model, providerId }。
 */
export function resolveModel(models, req) {
  const factory = BUILTIN_FACTORIES[req.provider];
  if (factory) {
    const p = factory();
    models.setProvider(p);
    const found = models.getModel(p.id, req.model);
    // baseUrl 一致或未提供 → 用内置目录（env 鉴权 pi-ai 自动解析）
    if (found && (!req.baseUrl || found.baseUrl === req.baseUrl)) {
      return { model: found, providerId: p.id };
    }
  }
  if (req.baseUrl) {
    const pid = `atbx-${sanitize(req.provider)}`;
    const model = {
      id: req.model,
      name: req.name || req.model,
      api: 'openai-completions',
      provider: pid,
      baseUrl: req.baseUrl,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: req.contextWindow || 128000,
      maxTokens: req.maxOutput || 8192,
      reasoning: false,
    };
    const auth = req.envKey
      ? { apiKey: envApiKeyAuth(req.name || req.provider, [req.envKey]) }
      : { apiKey: { name: req.name || req.provider, resolve: async () => ({ auth: {} }) } };
    models.setProvider(createProvider({
      id: pid, name: req.name || req.provider, baseUrl: req.baseUrl,
      auth, models: [model], api: openAICompletionsApi(),
    }));
    return { model: models.getModel(pid, req.model), providerId: pid };
  }
  throw new UnsupportedError(`no builtin provider or baseUrl for "${req.provider}/${req.model}"`);
}
```

- [ ] **Step 4: 跑测试通过（必要时按注回填 groq 真实模型 id）**

Run: `npm test`
Expected: sse 2 + providers 5 passing。

- [ ] **Step 5: Commit**

```bash
git add packages/agent-server/src/providers.mjs packages/agent-server/test/providers.test.mjs
git commit -m "feat(agent-server): provider resolution with dynamic OpenAI-compat fallback"
```

---

### Task 4: 会话存储（LRU + TTL）

**Files:**
- Create: `packages/agent-server/src/sessions.mjs`
- Test: `packages/agent-server/test/sessions.test.mjs`

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/sessions.mjs';

const mk = (id) => ({ id, agent: null, model: null, apiKey: null, lastUsed: 0, streaming: false });

test('LRU evicts oldest beyond capacity', () => {
  const s = new SessionStore(3, 60_000);
  s.set(mk('a')); s.set(mk('b')); s.set(mk('c'));
  s.get('a');                    // touch a → c 变最旧
  s.set(mk('d'));
  assert.equal(s.get('c'), undefined);
  assert.ok(s.get('a') && s.get('b') && s.get('d'));
});

test('TTL sweep drops idle sessions', () => {
  const s = new SessionStore(10, 50);
  s.set(mk('old'));
  s.peek('old').lastUsed = Date.now() - 1000;   // 直接拨表，不 touch
  assert.equal(s.get('old'), undefined);
});

test('get touches lastUsed', async () => {
  const s = new SessionStore(10, 80);
  s.set(mk('x'));
  await new Promise((r) => setTimeout(r, 30));
  s.get('x');
  assert.ok(s.peek('x').lastUsed > Date.now() - 1000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/sessions.mjs'`

- [ ] **Step 3: 实现**

```javascript
// 内存会话：Map 插入序即 LRU 序；get/set 触发 TTL 清扫。重启即清空，key 不落盘。
export class SessionStore {
  constructor(capacity = 16, ttlMs = 30 * 60_000) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }
  #sweep() {
    const now = Date.now();
    for (const [id, s] of this.map) {
      if (now - s.lastUsed > this.ttlMs) this.map.delete(id);
    }
  }
  get(id) {
    this.#sweep();
    const s = this.map.get(id);
    if (!s) return undefined;
    this.map.delete(id);
    s.lastUsed = Date.now();
    this.map.set(id, s);
    return s;
  }
  peek(id) { return this.map.get(id); }        // 不 touch（测试/内部用）
  set(session) {
    this.#sweep();
    this.map.delete(session.id);
    this.map.set(session.id, session);
    while (this.map.size > this.capacity) {
      this.map.delete(this.map.keys().next().value);
    }
  }
  get size() { return this.map.size; }
}
```

- [ ] **Step 4: 跑测试通过**

Run: `npm test`
Expected: 全部 passing（sse 2 + providers 5 + sessions 3）。

- [ ] **Step 5: Commit**

```bash
git add packages/agent-server/src/sessions.mjs packages/agent-server/test/sessions.test.mjs
git commit -m "feat(agent-server): LRU session store with TTL"
```

---

### Task 5: HTTP 服务器（路由 + SSE 流 + CORS/PNA + 127.0.0.1）

**Files:**
- Create: `packages/agent-server/src/server.mjs`、`packages/agent-server/src/version.mjs`
- Test: `packages/agent-server/test/server.test.mjs`

依赖注入点：`startServer({ port, allowedOrigins, resolve, models })`——`resolve` 默认真实 `resolveModel`，测试注入 faux。

- [ ] **Step 1: version.mjs**

```javascript
import pkg from '../package.json' with { type: 'json' };
export const VERSION = pkg.version;
```

- [ ] **Step 2: 写失败测试**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { Agent } from '@earendil-works/pi-agent-core';
import { startServer } from '../src/server.mjs';

// 每个测试起独立 server + faux provider
async function withFauxServer(t, origins = ['http://localhost:4321']) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const resolve = () => ({ model: faux.getModel(), providerId: faux.provider.id });
  const srv = await startServer({ port: 0, allowedOrigins: origins, resolve, models });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const json = async (path, opts) => {
    const res = await fetch(base + path, opts);
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  return { srv, base, json, faux, models };
}

test('health returns ok + version', async (t) => {
  const { json } = await withFauxServer(t);
  const { status, body } = await json('/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
});

test('CORS: allowed origin passes, unknown origin blocked', async (t) => {
  const { json } = await withFauxServer(t, ['https://dengzhh.github.io']);
  const ok = await fetch(`http://x/health`); // 占位避免 lint；实际断言下两行
  ok.body?.cancel();
  const good = await json('/health', { headers: { Origin: 'https://dengzhh.github.io' } });
  assert.equal(good.status, 200);
  const bad = await json('/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.status, 403);
});

test('preflight includes PNA header', async (t) => {
  const { base } = await withFauxServer(t);
  const res = await fetch(base + '/sessions', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:4321',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Private-Network': 'true',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
});

test('session + message round-trip streams SSE', async (t) => {
  const { json, base, faux } = await withFauxServer(t);
  faux.setResponses([fauxAssistantMessage([fauxText('Hello from faux!')])]);
  const create = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux' }),
  });
  assert.equal(create.status, 200);
  const { sessionId } = create.body;

  const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const raw = await res.text();
  const events = raw.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
  const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.equal(deltas, 'Hello from faux!');
  assert.ok(events.some((e) => e.type === 'turn_end'));
  assert.equal(events.at(-1).type, 'done');
});

test('unknown session 404, malformed JSON 400', async (t) => {
  const { json } = await withFauxServer(t);
  assert.equal((await json('/sessions/nope/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'x' }),
  })).status, 404);
  assert.equal((await json('/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: '{oops',
  })).status, 400);
});
```

注：CORS 测试里那两行 `const ok = await fetch('http://x/health')` 占位是防呆样板——实现时直接删掉这两行，只留后两个断言。（写计划时误留，实现者删除即可。）

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/server.mjs'`

- [ ] **Step 4: 实现 server.mjs**

```javascript
// 只监听 127.0.0.1 的 agent 桥：health / sessions / messages(SSE) / abort。
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Agent } from '@earendil-works/pi-agent-core';
import { resolveModel } from './providers.mjs';
import { SessionStore } from './sessions.mjs';
import { encodeSSE } from './sse.mjs';
import { VERSION } from './version.mjs';

const SYSTEM_PROMPT = 'You are a helpful assistant chatting in the AgentToolbox web app. Be concise and useful.';

const DEFAULT_ORIGINS = ['https://dengzhh.github.io'];

function corsHeaders(origin, allowed) {
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

async function readJson(req, cap = 1_000_000) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > cap) throw Object.assign(new Error('body too large'), { statusCode: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function makeAgent(models, model, sessionId, apiKey) {
  return new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model },
    streamFn: models.streamSimple.bind(models),
    sessionId,
    getApiKey: () => apiKey,
  });
}

export async function startServer({ port = 0, hostname = '127.0.0.1', allowedOrigins = DEFAULT_ORIGINS, resolve = resolveModel, models }) {
  const sessions = new SessionStore();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;

    // 预检（含 Chrome PNA：https 公网站点访问 localhost 的关键）
    if (req.method === 'OPTIONS') {
      const cors = corsHeaders(origin, allowedOrigins);
      if (!cors) { res.writeHead(403).end(); return; }
      res.writeHead(204, {
        ...cors,
        ...(req.headers['access-control-request-private-network'] === 'true'
          ? { 'access-control-allow-private-network': 'true' } : {}),
      });
      res.end();
      return;
    }

    const cors = origin === undefined ? {} : (corsHeaders(origin, allowedOrigins) ?? null);
    if (cors === null) { res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"origin not allowed"}'); return; }
    const json = (code, obj) => res.writeHead(code, { 'content-type': 'application/json', ...cors }).end(JSON.stringify(obj));

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(200, { ok: true, version: VERSION, grantedDirs: [] });
      }

      if (req.method === 'POST' && url.pathname === '/sessions') {
        const body = await readJson(req);
        const { model, providerId } = resolve(models, body);
        const id = randomUUID();
        const agent = makeAgent(models, model, id, body.apiKey ?? null);
        sessions.set({ id, agent, model, providerId, apiKey: body.apiKey ?? null, lastUsed: Date.now(), streaming: false });
        return json(200, { sessionId: id, provider: body.provider, model: body.model });
      }

      const msgMatch = req.method === 'POST' && url.pathname.match(/^\/sessions\/([0-9a-f-]+)\/messages$/);
      if (msgMatch) {
        const session = sessions.get(msgMatch[1]);
        if (!session) return json(404, { error: 'unknown session' });
        if (session.streaming) return json(409, { error: 'already streaming' });
        const { text } = await readJson(req);
        if (typeof text !== 'string' || !text.trim()) return json(400, { error: 'text required' });

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          ...cors,
        });
        const send = (type, payload) => res.write(encodeSSE(type, payload));
        session.streaming = true;
        // 客户端断开 → 中止本轮生成
        res.on('close', () => { if (session.streaming) session.agent.abort(); });
        const unsub = session.agent.subscribe((ev) => {
          if (ev.type === 'message_update' && ev.assistantMessageEvent.type === 'text_delta') {
            send('delta', { text: ev.assistantMessageEvent.delta });
          } else if (ev.type === 'turn_end') {
            send('turn_end', { stopReason: ev.message.stopReason ?? null });
          }
        });
        try {
          await session.agent.prompt(text);
        } catch (err) {
          send('error', { message: String(err?.message ?? err) });
        } finally {
          unsub();
          session.streaming = false;
          send('done', {});
          res.end();
        }
        return;
      }

      const abortMatch = req.method === 'POST' && url.pathname.match(/^\/sessions\/([0-9a-f-]+)\/abort$/);
      if (abortMatch) {
        const session = sessions.get(abortMatch[1]);
        if (!session) return json(404, { error: 'unknown session' });
        session.agent.abort();
        return res.writeHead(204, cors).end();
      }

      return json(404, { error: 'not found' });
    } catch (err) {
      const code = err.statusCode ?? (err.name === 'UnsupportedError' ? 400 : 500);
      return json(code, { error: err.name === 'UnsupportedError' ? 'unsupported' : 'internal', message: String(err?.message ?? err) });
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, resolvePromise);
  });
  return {
    server,
    port: server.address().port,
    sessions,
    close: () => new Promise((r) => server.close(r)),
  };
}
```

- [ ] **Step 5: 跑测试通过**

Run: `npm test`
Expected: 全部 passing（sse 2 + providers 5 + sessions 3 + server 5）。

- [ ] **Step 6: Commit**

```bash
git add packages/agent-server/src/server.mjs packages/agent-server/src/version.mjs packages/agent-server/test/server.test.mjs
git commit -m "feat(agent-server): loopback HTTP server with SSE chat and CORS/PNA"
```

---

### Task 6: bin 入口（npx 启动）+ 冒烟

**Files:**
- Create: `packages/agent-server/bin/agenttoolbox-agent.mjs`

- [ ] **Step 1: 实现 bin**

```javascript
#!/usr/bin/env node
// agenttoolbox-agent — AgentToolbox 本地智能体桥。仅回环监听。
import { createModels } from '@earendil-works/pi-ai';
import { startServer } from '../src/server.mjs';

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : Number(process.env.PORT ?? 31415);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('invalid --port'); process.exit(1);
}
if (args.includes('--host') || args.includes('-H')) {
  // MVP 安全边界：禁止非回环监听（spec Security 节）
  console.error('agenttoolbox-agent binds to 127.0.0.1 only; --host is not supported');
  process.exit(1);
}

const allowedOrigins = [
  'https://dengzhh.github.io',
  ...(process.env.AGENT_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
];

const models = createModels();
const srv = await startServer({ port, allowedOrigins, models });
console.log(`agenttoolbox-agent v${(await import('../src/version.mjs')).VERSION} listening on http://127.0.0.1:${srv.port}`);
console.log(`allowed origins: ${allowedOrigins.join(', ')}`);
```

- [ ] **Step 2: chmod +x，本地冒烟**

Run:
```bash
chmod +x packages/agent-server/bin/agenttoolbox-agent.mjs
node packages/agent-server/bin/agenttoolbox-agent.mjs --port 31415 &
sleep 1
curl -s http://127.0.0.1:31415/health
kill %1
```
Expected: `{"ok":true,"version":"0.1.0","grantedDirs":[]}`

- [ ] **Step 3: 全量测试 + Commit**

Run: `cd packages/agent-server && npm test` → 全绿。

```bash
git add packages/agent-server/bin
git commit -m "feat(agent-server): npx entrypoint, loopback-only"
```

---

### Task 7: 网站客户端库 agentchat.ts

**Files:**
- Create: `src/lib/agentchat.ts`
- Test: `src/lib/agentchat.test.ts`（vitest，已被 Task 1 的 include 覆盖）

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, expect, it } from 'vitest';
import { parseSSEChunk, keyFor } from './agentchat';

describe('parseSSEChunk', () => {
  it('parses complete blocks and keeps partial in rest', () => {
    const { events, rest } = parseSSEChunk('data: {"type":"delta","text":"a"}\n\ndata: {"type":"del');
    expect(events).toEqual([{ type: 'delta', text: 'a' }]);
    expect(rest).toBe('data: {"type":"del');
  });
  it('skips comments and invalid JSON', () => {
    const { events } = parseSSEChunk(': ping\n\ndata: not-json\n\ndata: {"type":"done"}\n\n');
    expect(events).toEqual([{ type: 'done' }]);
  });
  it('joins multi-line data blocks', () => {
    const { events } = parseSSEChunk('data: {"type":"delta",\ndata: "text":"x"}\n\n');
    expect(events).toEqual([{ type: 'delta', text: 'x' }]);
  });
});

describe('keyFor', () => {
  it('namespaces per provider', () => {
    expect(keyFor('groq')).toBe('atbx:key:groq');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/agentchat.test.ts`
Expected: FAIL — `Cannot find module './agentchat'`

- [ ] **Step 3: 实现**

```typescript
// AgentToolbox 本地智能体桥客户端：SSE 解析为纯函数可测；网络函数薄封装。
export const AGENT_URL = 'http://127.0.0.1:31415';

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'turn_end'; stopReason: string | null }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface SessionRequest {
  provider: string;
  model: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  envKey?: string | null;
  name?: string | null;
  contextWindow?: number;
  maxOutput?: number;
}

/** 把 SSE 字节流按 \n\n 分块；返回已解析事件与未完成的尾部（下次拼接）。 */
export function parseSSEChunk(buffer: string): { events: ChatEvent[]; rest: string } {
  const events: ChatEvent[] = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('');
    if (!data) continue; // 注释心跳等
    try { events.push(JSON.parse(data) as ChatEvent); } catch { /* 跳过坏帧 */ }
  }
  return { events, rest };
}

export const keyFor = (provider: string) => `atbx:key:${provider}`;

export const keyStorage = {
  get(provider: string): string | null {
    try { return localStorage.getItem(keyFor(provider)); } catch { return null; }
  },
  set(provider: string, key: string): void {
    try { localStorage.setItem(keyFor(provider), key); } catch { /* 隐身模式等 */ }
  },
};

export interface HealthInfo { ok: boolean; version: string; grantedDirs: string[] }

export async function probeHealth(baseUrl = AGENT_URL, signal?: AbortSignal): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal });
    if (!res.ok) return null;
    return (await res.json()) as HealthInfo;
  } catch { return null; }
}

export async function createSession(body: SessionRequest, baseUrl = AGENT_URL): Promise<string> {
  const res = await fetch(`${baseUrl}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`session create failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { sessionId: string };
  return data.sessionId;
}

/** 发一条消息并流式回调事件；返回时流已结束。signal 中止时 fetch 抛 AbortError。 */
export async function streamMessage(
  sessionId: string,
  text: string,
  onEvent: (ev: ChatEvent) => void,
  signal?: AbortSignal,
  baseUrl = AGENT_URL,
): Promise<void> {
  const res = await fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSSEChunk(buffer);
    buffer = rest;
    events.forEach(onEvent);
  }
}

export async function abortSession(sessionId: string, baseUrl = AGENT_URL): Promise<void> {
  await fetch(`${baseUrl}/sessions/${sessionId}/abort`, { method: 'POST' }).catch(() => {});
}
```

- [ ] **Step 4: 跑测试通过 + 全站测试**

Run: `npx vitest run src/lib/agentchat.test.ts && npm test`
Expected: agentchat 4 passing；根测试全绿。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agentchat.ts src/lib/agentchat.test.ts
git commit -m "feat(site): agentchat client (SSE parse + session/stream helpers)"
```

---

### Task 8: free-models 页 Chat 按钮 + 聊天抽屉

**Files:**
- Modify: `src/pages/free-models.astro`

- [ ] **Step 1: 表格行加 Chat 链接**

在 `<td><a href="#configure" class="pick" data-provider={p.id} data-model={m.id}>Configure →</a></td>`
后新增一列内容（同一 td 内追加即可，不新增表列）：

```astro
<td>
  <a href="#configure" class="pick" data-provider={p.id} data-model={m.id}>Configure →</a>
  {p.id !== 'github-copilot' && (
    <br /><a href="#chat" class="chat-pick" data-provider={p.id} data-model={m.id}
      data-base={p.api ?? ''} data-envkey={p.envKey} data-ctx={m.context} data-maxout={m.maxOutput}
      data-name={m.name} data-keyless={p.id === 'opencode' ? '1' : '0'}>Chat →</a>
  )}
</td>
```

- [ ] **Step 2: 抽屉 markup（`</BaseLayout>` 前插入）**

```astro
<aside id="chat-drawer" aria-label="Chat with this model" aria-hidden="true">
  <header class="chat-head">
    <div><strong id="chat-model-name"></strong><div id="chat-provider-name" class="chat-sub"></div></div>
    <button id="chat-close" type="button" aria-label="Close chat">✕</button>
  </header>
  <div id="chat-install" class="chat-pane" hidden>
    <p>Chat runs through a tiny local service (your keys never leave your machine):</p>
    <pre class="chat-cmd"><code>npx agenttoolbox-agent@latest</code></pre>
    <button id="chat-copy-cmd" type="button" class="cap-chip">Copy command</button>
    <p class="chat-sub">Waiting for the local service…</p>
  </div>
  <div id="chat-key" class="chat-pane" hidden>
    <p>This provider needs an API key. It's stored in your browser and sent only to your local agent.</p>
    <label for="chat-key-input">API key</label>
    <input id="chat-key-input" type="password" autocomplete="off" />
    <button id="chat-key-save" type="button">Save &amp; continue</button>
  </div>
  <div id="chat-main" class="chat-pane" hidden>
    <div id="chat-log" aria-live="polite"></div>
    <form id="chat-form">
      <textarea id="chat-input" rows="2" placeholder="Ask anything…"></textarea>
      <div class="chat-actions">
        <button type="submit" id="chat-send">Send</button>
        <button type="button" id="chat-abort" hidden>Stop</button>
      </div>
    </form>
  </div>
</aside>
```

- [ ] **Step 3: 样式（追加到页面 `<style>` 块）**

```css
/* ---------- chat drawer ---------- */
#chat-drawer {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: min(430px, 100vw);
  background: var(--surface); border-left: 1px solid var(--line-strong);
  box-shadow: -12px 0 32px rgba(0,0,0,0.35);
  transform: translateX(102%); transition: transform .25s ease;
  display: flex; flex-direction: column; z-index: 60;
  padding: 1rem 1.1rem;
}
#chat-drawer.is-open { transform: translateX(0); }
.chat-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--line); padding-bottom: .6rem; }
.chat-sub { font-size: .8rem; color: var(--ink-soft); }
.chat-pane { display: flex; flex-direction: column; gap: .6rem; overflow-y: auto; flex: 1; }
#chat-main { min-height: 0; }
#chat-log { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: .55rem; padding: .3rem 0; }
.chat-msg { padding: .5rem .7rem; border-radius: 10px; white-space: pre-wrap; font-size: .92rem; }
.chat-msg--user { background: var(--cobalt-wash); align-self: flex-end; }
.chat-msg--assistant { background: rgba(127,127,127,0.12); align-self: flex-start; }
.chat-msg--error { color: #ff8f8f; }
.chat-cmd { background: #0f1830; color: #e7ebf4; padding: .7rem .8rem; border-radius: 8px; overflow-x: auto; font-size: .85rem; }
#chat-form textarea { width: 100%; resize: vertical; }
.chat-actions { display: flex; gap: .6rem; margin-top: .4rem; }
a.chat-pick { display: inline-block; margin-top: .25rem; }
```

- [ ] **Step 4: 抽屉脚本（追加到页面 `<script>` 末尾，import 已有的 agentchat）**

```typescript
  import { probeHealth, createSession, streamMessage, abortSession, keyStorage, type ChatEvent } from '../lib/agentchat';

  // ── Chat 抽屉：探测本地 agent → 建 session → SSE 聊天 ──
  const drawer = $('chat-drawer');
  const panes = { install: $('chat-install'), key: $('chat-key'), main: $('chat-main') } as Record<string, HTMLElement>;
  const chatLog = $('chat-log');
  const chatInput = $('chat-input') as HTMLTextAreaElement;
  const sendBtn = $('chat-send') as HTMLButtonElement;
  const abortBtn = $('chat-abort') as HTMLButtonElement;
  type ChatState = {
    provider: string; model: string; base: string; envKey: string;
    ctx: number; maxOut: number; name: string; keyless: boolean;
    sessionId: string | null; streaming: boolean; probeTimer?: ReturnType<typeof setInterval>;
    streamAbort?: AbortController;
  };
  let chat: ChatState | null = null;

  const showPane = (k: 'install' | 'key' | 'main') => {
    for (const [name, el] of Object.entries(panes)) el.hidden = name !== k;
  };
  const chatMsg = (role: 'user' | 'assistant' | 'error', text: string) => {
    const div = document.createElement('div');
    div.className = `chat-msg chat-msg--${role}`;
    div.textContent = text;
    chatLog.append(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    return div;
  };

  function stopProbe() { if (chat?.probeTimer) { clearInterval(chat.probeTimer); chat.probeTimer = undefined; } }

  async function ensureSession(): Promise<void> {
    const c = chat!;
    if (c.sessionId) return;
    const apiKey = c.keyless ? null : keyStorage.get(c.provider);
    c.sessionId = await createSession({
      provider: c.provider, model: c.model, baseUrl: c.base || null, apiKey,
      envKey: c.envKey || null, name: c.name, contextWindow: c.ctx, maxOutput: c.maxOut,
    });
  }

  async function tryGoChat(): Promise<void> {
    const c = chat!;
    if (!(await probeHealth())) { showPane('install'); stopProbe(); c.probeTimer = setInterval(tryGoChat, 3000); return; }
    stopProbe();
    if (!c.keyless && !keyStorage.get(c.provider)) { showPane('key'); return; }
    try { await ensureSession(); showPane('main'); chatInput.focus(); }
    catch (e) { chatMsg('error', String((e as Error).message)); showPane('key'); }
  }

  function openChat(a: HTMLAnchorElement) {
    chat = {
      provider: a.dataset.provider!, model: a.dataset.model!, base: a.dataset.base ?? '',
      envKey: a.dataset.envkey ?? '', ctx: Number(a.dataset.ctx), maxOut: Number(a.dataset.maxout),
      name: a.dataset.name ?? '', keyless: a.dataset.keyless === '1',
      sessionId: null, streaming: false,
    };
    $('chat-model-name').textContent = chat.name;
    $('chat-provider-name').textContent = `${chat.provider} · ${chat.model}`;
    chatLog.textContent = '';
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    void tryGoChat();
  }

  document.querySelectorAll<HTMLAnchorElement>('a.chat-pick').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); openChat(a); });
  });
  $('chat-close').addEventListener('click', () => {
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    stopProbe();
    chat?.streamAbort?.abort();
  });
  $('chat-copy-cmd').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText('npx agenttoolbox-agent@latest'); } catch { /* 手选 */ }
  });
  $('chat-key-save').addEventListener('click', () => {
    const v = ($('chat-key-input') as HTMLInputElement).value.trim();
    if (!v || !chat) return;
    keyStorage.set(chat.provider, v);
    void tryGoChat();
  });

  $('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = chat;
    if (!c?.sessionId || c.streaming) return;
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    chatMsg('user', text);
    const outDiv = chatMsg('assistant', '');
    c.streaming = true; sendBtn.disabled = true; abortBtn.hidden = false;
    c.streamAbort = new AbortController();
    abortBtn.onclick = () => { c.streamAbort?.abort(); void abortSession(c.sessionId!); };
    try {
      await streamMessage(c.sessionId, text, (ev: ChatEvent) => {
        if (ev.type === 'delta') outDiv.textContent += ev.text;
        else if (ev.type === 'error') outDiv.textContent += `\n[error] ${ev.message}`;
        chatLog.scrollTop = chatLog.scrollHeight;
      }, c.streamAbort.signal);
    } catch { outDiv.textContent += '\n[connection closed]'; }
    finally { c.streaming = false; sendBtn.disabled = false; abortBtn.hidden = true; }
  });
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ($('chat-form') as HTMLFormElement).requestSubmit(); }
  });
```

- [ ] **Step 5: 构建验证**

Run: `npm run build`
Expected: `11 page(s) built`，无 TS 报错。

- [ ] **Step 6: 浏览器状态验证（dev server 已在跑）**

1. 后端未启动时打开 `http://localhost:4321/agent-site/free-models/`，点任一行 Chat →：抽屉滑入，显示 install 面板与 npx 命令（截图核对）。
2. `node packages/agent-server/bin/agenttoolbox-agent.mjs &` 后 ≤3s：抽屉自动切到 key 面板（选非 opencode 行）或 chat 面板（opencode 行）（截图核对）。
3. 造一个真实会话流式冒烟（有 OpenCode Zen 网络即可）：
```bash
SID=$(curl -s http://127.0.0.1:31415/sessions -H 'content-type: application/json' \
  -d '{"provider":"opencode","model":"mimo-v2-pro-free","baseUrl":"https://opencode.net/v1","name":"MiMo","contextWindow":200000,"maxOutput":8192}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["sessionId"])')
curl -N http://127.0.0.1:31415/sessions/$SID/messages -H 'content-type: application/json' -d '{"text":"用一句话自我介绍"}'
```
Expected: SSE 流出 delta 帧与 done。若 zen 端点/模型名与 free-models 数据不符，以 `src/data/free-models.json` 里 opencode 节的实际 baseUrl/model 为准替换。

- [ ] **Step 7: Commit**

```bash
git add src/pages/free-models.astro
git commit -m "feat(site): chat drawer on free-models (probe/install/key/chat states)"
```

---

### Task 9: 发布 workflow + 收尾验证

**Files:**
- Create: `.github/workflows/publish-agent-server.yml`
- Modify: `packages/agent-server/README.md`（若 Task 8 冒烟发现端点/模型名差异，回填勘误）

- [ ] **Step 1: publish workflow**

```yaml
name: Publish agent-server

on:
  push:
    tags: ['agent-server-v*']

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm test --workspace agenttoolbox-agent
      - run: npm publish --access public
        working-directory: packages/agent-server
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 2: 全量回归**

Run: `npm test && npm run build && cd packages/agent-server && npm test`
Expected: 根 vitest 全绿（含 agentchat 4 个新测试）；`11 page(s) built`；agent-server 15 个测试全绿。

- [ ] **Step 3: 部署冒烟说明（发布后手动，不在 CI）**

用户配置 `NPM_TOKEN` secret → `git tag agent-server-v0.1.0 && git push --tags` → workflow publish → `npx agenttoolbox-agent@latest` 实机验证。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/publish-agent-server.yml packages/agent-server/README.md
git commit -m "ci: npm publish workflow for agent-server"
```

---

## Self-Review 记录

- **Spec 覆盖**：接口四端点（Task 5）、模型解析顺序（Task 3）、LRU/TTL（Task 4）、CORS/PNA/loopback（Task 5/6）、抽屉四态（Task 8）、key localStorage（Task 7/8）、publish（Task 9）均有对应任务。渐进式授权仅 `/health.grantedDirs` 占位（Task 5）✓ 符合 MVP 范围。
- **占位符**：无 TBD；Task 5 测试中标注了一处需删除的防呆样板（已明示）。
- **类型一致性**：SSE 事件 `delta/turn_end/error/done` 前后端一致；`SessionRequest` 字段与 `/sessions` body 一致；`resolveModel(models, req)` 在 server 中以注入默认值方式调用 ✓。
