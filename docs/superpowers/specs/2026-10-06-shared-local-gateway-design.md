# 共享本地网关 + 可插拔 Agent 适配器（pi / Claude Code）

日期：2026-10-06
状态：已与用户对齐（自动路由 / 复用系统 CLI / 默认纯聊天 / 扩展现有包 /
数据层标注 / 网关侧授权 / pi 保留默认 / resume 续会话 / 不做静默降级）

## 问题

当前 `agenttoolbox-agent` 只支持 pi 运行时。两个新需求：

1. **OpenRouter 的 "agentic harness" gate**：部分免费模型只对官方编码智能体
   放行，我们的 pi 后端一律 403。已实测：真·Claude Code 运行时经
   `ANTHROPIC_BASE_URL=https://openrouter.ai/api` 调用这些模型可正常返回
   （`thinkingmachines/inkling-small:free` → `PONG`）。
2. **工具能力**：pi 后端本阶段无工具（纯对话）。Claude Code 自带读写文件 /
   执行命令，接入后可直接获得（配合目录授权闸门）。

同时要预留扩展位：今后新增 agent（如其它 CLI 智能体）只加一个适配器。

## 已验证的关键事实（2026-10-06 实测）

| 事实 | 证据 |
|---|---|
| CC 运行时能放行 gate 模型 | `cc-openrouter-probe.mjs` → `RESULT: success` / `TEXT: PONG` |
| 无需 SDK 包，直接驱动 CLI 即可 | `cc-cli-probe.sh` → `"text":"PONG"`，零 SDK 依赖 |
| CLI 支持流式 headless | `claude -p --output-format=stream-json --include-partial-messages --verbose` |
| **必须隔离用户配置** | 不加隔离时 CLI 读了 `~/.claude/settings.json`：用了本机默认模型、还执行了用户自己的 SessionStart hook |
| 隔离手段 | `CLAUDE_CONFIG_DIR=<临时空目录>` 生效（输出不再出现本机模型名 / hook） |
| Claude Agent SDK 亦可（备选） | `@anthropic-ai/claude-agent-sdk` + `settingSources: []`，但会拉 240MB 二进制 |

## 架构

```
网站抽屉 ──HTTP/SSE──→ agenttoolbox-agent 0.2.0（本地网关，仅回环）
                          │  /health /sessions /sessions/:id/messages
                          │  agent registry（适配器注册表）
                    ┌─────┴─────┐
                    │           │
              pi adapter    cc adapter
              进程内 pi-ai   spawn `claude` CLI
              默认、快、无依赖  重型：gate 模型 + 工具
```

### 适配器接口（新增 agent 的最小实现面）

```js
{
  id: 'pi' | 'cc',
  async available(): Promise<boolean>,       // cc: 探测 PATH 中的 claude
  async *run({ messages, model, apiKey, baseUrl, cwd, tools })
      : AsyncIterable<AgentEvent>            // 事件契约与现状一致
}
```

`AgentEvent` = `{type:'delta',text}` | `{type:'turn_end',stopReason}` |
`{type:'error',message}` | `{type:'done'}` —— **与现有 SSE 契约完全相同**，
所以 `src/lib/agentchat.ts` 与抽屉 UI 零改动。

### 路由（数据层标注为主，运行时回退兜底）

- free-models.json 每个模型增加 `agents: ('pi'|'cc')[]`；缺省视为 `['pi']`
- 网关按标注选择适配器
- **兜底**：pi 请求遇到 gate 类 403（错误消息含 `agentic harness` / 特定
  code）→ 自动改走 cc 重试，并把该 model id 记入本地 override 表（下次直接走 cc）
- 标注由同步脚本生成：被 gate 的 OpenRouter 模型标 `['cc']`

### 目录授权（网关侧，浏览器无本地路径访问权）

```bash
npx agenttoolbox-agent grant <dir>    # 授权一个目录（可多次）
npx agenttoolbox-agent list           # 列出已授权目录
npx agenttoolbox-agent revoke <dir>   # 撤销
```
- 存于网关自己的配置文件（如 `~/.config/agenttoolbox/config.json`），**不写用户
  Claude 配置**
- 授权后 cc 适配器：`cwd = 授权目录`，工具集解锁**只读**（Read / Grep / Glob）
- **未授权 = 纯聊天**（`allowedTools` 为空），与现状一致
- `/health` 返回 `grantedDirs` 供网站展示

### 会话连续性

cc 适配器使用 `--resume <session_id>`（CLI 输出含 session_id），避免每轮重放
完整历史、节省 token。网关会话对象保存 `{ ccSessionId }`。

### 降级策略

cc 不可用（用户未装 Claude Code）且模型标 `['cc']` → **不静默降级到 pi**
（必然失败）。网站抽屉显示引导：`需要 Claude Code 运行时` + 安装命令
（复用现有 npx 引导的交互模式）。

## 交付物

1. `packages/agent-server/src/adapters/`：`pi.mjs`（从现有 server.mjs 抽出）、
   `cc.mjs`（新）、`registry.mjs`
2. `src/server.mjs` 改造：适配器路由 + `/health.agents` + `/health.grantedDirs`
3. `bin/agenttoolbox-agent.mjs`：新增 `grant` / `list` / `revoke` 子命令
4. `scripts/sync-free-models.mjs`：输出每个模型的 `agents` 标注
5. 网站：`agentchat.ts` 解析 `/health.agents`；抽屉按需显示 CC 引导
6. 测试：适配器单测（cc 用 stub CLI 脚本）、registry 路由测试、授权存取测试

## 明确不做（本阶段）

- 写文件 / 执行命令工具（只读先行，写操作下一阶段单独设计）
- 除 pi / cc 外的适配器
- 网关侧多用户 / 鉴权（仍为单用户回环）
- 静默把 cc 降级为 pi
