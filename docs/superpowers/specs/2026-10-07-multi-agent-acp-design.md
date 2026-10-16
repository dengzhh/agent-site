# 多 Agent 接入（ACP）+ Agent 选择界面

日期：2026-10-07
状态：调研与可行性验证完成，方案已与用户对齐

## 目标

网站 Chat 抽屉支持多种主流 coding agent，用户可在界面选择用哪个 agent 对话。

## 范围（已与用户确认）

**纳入 7 个**：pi、claude-code、hermes、openclaw、opencode、codex、dsh
**剔除 2 个**：
- `workbuddy` —— GUI 桌面应用，无 CLI/headless/ACP，无法被 spawn 驱动
- `cursor` —— ACP 可用但**不支持自定义端点**（无 baseURL 配置），无法参与 BYOK 流程

**不做 LLM 网关层**（Higress/LiteLLM）——会给用户增加配置复杂度。
自动模型切换若将来要做，集成进本地服务自身。

## 可行性验证（2026-10-07 实测，全部一手证据）

### ACP 标准可用

- 官方站 https://agentclientprotocol.com，Zed Industries 维护，**协议版本 v1 稳定**
- 传输：JSON-RPC 2.0 over stdio
- 官方 Node SDK：`@agentclientprotocol/sdk@1.7.0`
- 注册表 41 个 agent

### hermes 端到端跑通（决定性证据）

用探针脚本（`scripts/verify/acp-probe.mjs`）驱动 `hermes acp`，完整链路成功：

```
INIT ok. agentCapabilities: {"loadSession":true,"sessionCapabilities":{"fork":{},"list":{},"resume":{}}}
SESSION: e8ea782e-a3bd-43e7-b9a1-d9c7c4442112
[update: agent_thought_chunk]      ← 思维链通知
PONG                               ← 流式文本，实时到达
[update: usage_update]             ← token 用量
PROMPT done. stopReason: end_turn
TEXT: "PONG"
```

### SDK 正确用法（踩坑记录，实现必须照此）

```javascript
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

// ① ndJsonStream(output, input)：output = 我们写→agent 读；input = agent 写→我们读
//    参数顺序反了会得到 "input.getReader is not a function"
// ② 需要 Web Streams，不是 Node 旧式 stream → toWeb 转换
const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
);
// ③ 用 ClientSideConnection 直连（比 client() 链式更贴合适配器需求）
const conn = new acp.ClientSideConnection((_agent) => clientImpl, stream);
await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
const s = await conn.newSession({ cwd, mcpServers: [] });
await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: 'text', text }] });
```

client 实现须提供：`sessionUpdate`（流式）、`requestPermission`（权限应答）、
`readTextFile`/`writeTextFile`（可抛 not supported）。

### 各 agent 的 ACP 入口（调研所得，实现时需逐个实测确认）

| agent | 入口 | 备注 |
|---|---|---|
| hermes | `hermes acp` | ✅ 已实测通过 |
| openclaw | `openclaw acp` | ⚠️ 实测超时无输出，疑需先起其 Gateway |
| opencode | `npx opencode-ai acp`（待确认子命令） | 注册表收录 |
| codex | `npx @zed-industries/codex-acp` | Zed 官方适配器 |
| dsh | `npx @deepseek-ai/dsh --profile acp` | 一等公民 ACP；本机未装 CLI |
| pi | **不用 ACP**，保留现有进程内适配器 | 已验证含多轮缓存，比 spawn 外部 CLI 更优 |
| claude-code | **不用 ACP**，保留现有 cc 适配器 | 已验证含 gate 突破与生命周期管理 |

## 架构

```
抽屉顶部 [Agent 下拉]  ← 只列本机探测到的可用 agent
        │
   POST /sessions { agent?, provider, model, apiKey, ... }
        │
   registry.pick(agents)   ← 已有，扩展为支持显式 agent 指定
        │
   ┌────┴──────────────────────────┐
   │ pi.mjs（已有） cc.mjs（已有）   │
   │ acp.mjs（🆕 一个覆盖 5 个 agent）│
   └───────────────────────────────┘
```

### ACP 适配器设计

单个 `src/adapters/acp.mjs`，内部维护 agent 定义表：

```javascript
const ACP_AGENTS = {
  hermes:   { cmd: 'hermes',   args: ['acp'],              isolateEnv: (dir) => ({ HERMES_HOME: dir }) },
  openclaw: { cmd: 'openclaw', args: ['acp'],              isolateEnv: (dir) => ({ OPENCLAW_HOME: dir }) },
  opencode: { cmd: 'opencode', args: ['acp'],              isolateEnv: (dir) => ({ OPENCODE_CONFIG_DIR: dir, OPENCODE_DISABLE_CLAUDE_CODE: '1' }) },
  codex:    { cmd: 'npx', args: ['-y', '@zed-industries/codex-acp'], isolateEnv: (dir) => ({ CODEX_HOME: dir }) },
  dsh:      { cmd: 'npx', args: ['-y', '@deepseek-ai/dsh', '--profile', 'acp'], isolateEnv: (dir) => ({ DSH_HOME: dir }) },
};
```

（上表的具体命令/环境变量以实现时实测为准——调研给出方向，必须逐个验证。）

职责：
1. `available(id)`：探测该 agent 的 CLI 是否存在（`which`/PATH 查找）
2. `run(ctx)`：spawn → 建 ACP 连接 → 会话 → prompt，把通知映射为 `AgentEvent`
   - `agent_message_chunk` → `{type:'delta', text}`
   - `agent_thought_chunk` → `{type:'thinking', text}`（新增事件类型，前端弱化展示）
   - `usage_update` → 累积，`turn_end` 时带上
   - `requestPermission` → 自动 `allow_once`（安全边界由 grant 机制在上层控制）
3. stderr 全量转入日志（hermes 实测输出大量插件注册日志，绝不能污染事件流）
4. 会话续接：ACP `session/new` 返回 sessionId，`session/resume` 续（各 agent 支持度不同，需降级处理）

### 界面（顶部 Agent 下拉）

```
┌─ Qwen3.8 27B (free) ────────────────┐
│ Agent: [Hermes ▾]  ← 仅已安装的       │
├─────────────────────────────────────┤
│ 用户: ...                            │
│ *[思考] 让我分析一下...*   ← 弱化样式  │
│ 助手: ...                            │
└─────────────────────────────────────┘
```

- `/health` 扩展：`agents: [{id, name, available}]`
- 下拉只展示 `available: true` 的 agent
- 若当前 agent 仅一个可用，下拉退化为静态文字（无额外认知负担）
- 思维链用斜体/浅色展示，与正式回复区分

## 交付物

1. `packages/agent-server/src/adapters/acp.mjs` + 测试（用假 ACP 服务端脚本，不依赖真实 agent）
2. `src/adapters/registry.mjs` 扩展：支持按 id 显式选择
3. `src/server.mjs`：`/health.agents` 带名称与可用性；`/sessions` 接受 `agent` 字段
4. `src/lib/agentchat.ts`：`ChatEvent` 增加 `thinking` 类型；`AgentStatus` 增加 `name`
5. `src/pages/free-models.astro`：顶部 Agent 下拉 + 思维链渲染
6. 各 agent 的实测验证记录（哪些真能跑通）

## 明确不做

- LLM 网关层（Higress/LiteLLM）
- workbuddy（无法接入）、cursor（不支持 BYOK）
- 为每个 agent 写专用适配器（ACP 已统一）
- 自动模型切换（将来集成进本地服务，非本期）

## 风险与待实测项

1. **各 agent ACP 实现完整度差异大**——hermes 已验证；openclaw 疑需前置服务；
   codex/dsh/opencode 待实测。实现时逐个跑通，跑不通的从 UI 移除并记录
2. **权限应答格式**——不同 agent 对 `requestPermission` 的期望可能不同，
   需按 agent 适配（探针里用 `allow_once`，实测有效）
3. **配置隔离变量名**——上表是调研推测，必须逐个实测确认（避免读到用户全局配置）
