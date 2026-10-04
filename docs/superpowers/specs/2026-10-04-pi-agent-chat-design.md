# 网页版 pi-agent 智能体集成（BYOK + 本地薄后端）

日期：2026-10-04
状态：已与用户对齐方向（BYOK、薄后端包、本仓库 monorepo、渐进式授权、MVP 先行）

## 问题

在 agent-site（纯静态 GitHub Pages 站）上集成一个可交互的 pi-agent 智能体：
用户在 free-models 页一键选中某个免费模型即可对话。网站无后端，
浏览器无法静默安装软件，智能体运行时（Node）必须另寻落点。

## 总体架构

```
agent-site（静态）                    agenttoolbox-agent（用户本机）
  free-models 表 + Chat 按钮    HTTP    npx agenttoolbox-agent@latest
  聊天抽屉 UI（SSE 流式渲染）  ──────→  只监听 127.0.0.1:31415
  BYOK key（localStorage）    fetch    pi-agent-core + pi-ai 运行时
                                       会话与 key 均为内存态
                                              │ apiKey（内存中转）
                                              ↓
                                       各免费模型 Provider API
```

分工：
- **网站**：模型数据、聊天 UI、安装引导、key 录入（存 localStorage，永不发给任何远端，只发给 localhost 后端）
- **本地后端**：agent 循环（pi-agent-core）、统一 LLM 调用（pi-ai）、会话内存管理
- **"自动安装"的现实形态**：点 Chat → 网站展示可复制的 `npx agenttoolbox-agent@latest`
  命令并每 3s 轮询 `GET /health`，用户在终端跑起后自动进入聊天态
  （Ollama 生态标准模式；浏览器无法也不应静默装软件）

## 后端包：`packages/agent-server/`（npm 名 `agenttoolbox-agent`）

- Node ≥22，零 Web 框架：`node:http` + 手写 SSE
- 依赖：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`
- bin：`npx agenttoolbox-agent` 直接启动；`--port`/`PORT` 覆盖（默认 31415）

### 接口（MVP）

| 端点 | 请求 | 响应 |
|---|---|---|
| `GET /health` | — | `{ok, version, grantedDirs:[]}`；同时服务 CORS 预检 |
| `POST /sessions` | `{provider, model, baseUrl?, apiKey?}` | `{sessionId, provider, model}` |
| `POST /sessions/:id/messages` | `{text}` | SSE：`delta`{text} / `turn_end`{stopReason,usage} / `error`{message} / `done` |
| `POST /sessions/:id/abort` | — | 204 |

### 模型解析顺序（解决 models.dev 与 pi-ai 静态目录漂移）

前端建会话时携带 free-models.json 中的 `{provider, model, baseUrl}`：

1. 命中内置 provider（openrouter/groq/mistral/cerebras/nvidia/together/fireworks/
   cloudflare-workers-ai/opencode/qwen-token-plan…）且 `getModel` 命中 → 直接用
2. 未命中但有 `baseUrl` → `pi-ai createProvider()` OpenAI 兼容（zai、deepinfra 等走此路）
3. 都不行 → 400 `unsupported`，前端行内提示

apiKey 解析：请求体显式 key > 进程 env（free-models 的 `envKey`，如 `GROQ_API_KEY`）> 无 key
（opencode/zen 免 key）。GitHub Copilot 需 OAuth，MVP 不提供 Chat 按钮。

### 会话管理

内存 `Map`，LRU 上限 16 个会话，30min 空闲逐出；重启即清空。key 不写盘、不打日志。

### 安全

- 只绑 127.0.0.1；拒绝 `0.0.0.0`（MVP 阶段直接禁止，做 --host 校验报错提示）
- CORS 精确白名单：`https://dengzhh.github.io`（+ `AGENT_ALLOWED_ORIGINS` env 供本地开发）
- Chrome PNA：OPTIONS 预检响应 `Access-Control-Allow-Private-Network: true`
  （HTTPS 公网站点 fetch localhost 的关键；非 Chrome 无此预检，不受影响）
- MVP 工具列表为空：后端是"能跑 agent 循环的模型代理"，无文件/命令能力

### 渐进式授权（本次只做阶段 1，接口留位）

- 阶段 1（MVP）：纯对话，无工具
- 阶段 2：`POST /grant` 目录授权 → 解锁只读工具（读文件/列目录），`/health.grantedDirs` 即为此铺路
- 阶段 3：写/执行工具 + 每次调用确认

## 网站端

### UI（free-models.astro）

- 每行加 **Chat →**（与 Configure → 并排），打开右侧滑入聊天抽屉
- 抽屉状态机：`探测中 → 未安装（npx 命令 + 复制按钮 + 自动轮询 health）→ 在线缺 key
  （key 输入框；opencode 免 key 直接进）→ 聊天中`
- 聊天：多轮上下文（后端内存会话）、流式渲染、头部显示 provider/model、
  换模型 = 关会话新建、Abort 按钮
- localStorage：`atbx:key:<providerId>`（用户可清）；OpenCode Zen 跳过 key 步骤

### 客户端库 `src/lib/agentchat.ts`

- `probeHealth()` 轮询、`createSession()`、`streamMessage()`（fetch + ReadableStream
  解析 SSE 行——EventSource 不支持 POST）、纯函数 `parseSSEChunk()` 可单测

## 交付物

1. `packages/agent-server/`：src（server、providers 映射、sessions、sse）、
   `node:test` 测试（映射、SSE 编码、CORS/PNA 头、LRU 逐出）、README
2. 网站：`src/lib/agentchat.ts`（+ vitest）、free-models 抽屉 UI 与样式
3. 根 package.json 加 `workspaces:["packages/*"]`；deploy workflow 不变（npm ci 天然覆盖）
4. `.github/workflows/publish-agent-server.yml`：打 `agent-server-v*` tag → npm publish
   （需要用户在 repo secrets 配 `NPM_TOKEN`）

## 验证

- 后端单测全绿（pi-ai 自带 faux provider，端到端不依赖真实网络）
- 手动冒烟：本地起后端 + OpenCode Zen 免 key 模型真实流式对话一轮
- 浏览器截图核对抽屉四态 + `npm run build` 通过

## 明确不做（MVP）

文件/命令工具（阶段 2/3）、会话持久化与列表、OAuth provider（GitHub Copilot）、
iframe 嵌 pi-web、聊天记录导出。
