# 本地智能体执行：工作目录 + 工具分级 + 确认流 + 用量展示

日期：2026-10-17
状态：方案已与用户对齐（全套工具+逐动作确认 / 抽屉输入路径 / cc 走 MCP 桥 /
pi 也加工具 / 两期交付 / 不做 LLM 网关层）

## 目标

把 Chat 抽屉从「纯对话」升级为「本地智能体执行」：用户设定工作目录、
选择工具级别，智能体可以读写文件、执行命令、完成复杂任务。危险动作
经抽屉权限卡逐个确认，人始终在环。

## 分期

- **期 1**：会话工作目录 + 工具分级（纯对话/只读）+ 三适配器只读工具 +
  用量展示
- **期 2**：写/执行能力 + 抽屉确认流（pi 钩子 / cc MCP 桥 / acp 转发）

两期独立可上线。本文档覆盖两期；实施计划按期分批。

## 前置事实（已验证）

- cc 适配器：`--allowedTools` 控制工具，cwd 即 CLI 工作目录（已上线）
- acp 适配器：`request_permission` 由 client 应答（探针已跑通 initialize/
  new/prompt 全链路）
- ACP `session/update` 通知已映射（agent_message_chunk/thought/usage/tool_call）
- 真实 ACP `usage_update` 形状 = `{used, size, cost?}`（上下文窗口用量）
- OpenRouter 免费额度：50 请求/天（无充值）/ 1000 请求/天（充值 $10），
  `GET /api/v1/key`（带用户 key）可查 `{usage, limit, is_free_tier, rate_limit}`
- pi-agent-core：`Agent` initialState 支持 `tools: AgentTool[]`；
  `AgentTool` 含 label/execute；**SDK 无内置工具实现**（需自写）
- 网关配置存储 `config.mjs` 已有 grant 机制（`grantedDirs`），本设计改用
  **会话级 cwd**（随会话走、网页可设），终端 grant 保留但不再是主路径

## 期 1 设计

### 会话与状态

- `POST /sessions` 新增 `cwd?: string`、`toolTier?: 'none'|'read'`：
  - cwd 校验：`fs.statSync` 存在且 isDirectory，否则 400
    `{error:'invalid cwd', message}`（附 os.homedir 提示方便粘贴）
  - toolTier 缺省 'none'（纯对话，行为与现状完全一致）
  - 会话状态增加 `{cwd, toolTier}`
- 抽屉：路径输入框（粘贴本机路径）+ 工具级别下拉（cwd 未设时禁用级别下拉）；
  改目录/级别 = 新会话（清 sessionId 重建，与换 Agent 同模式）

### 只读工具（三适配器）

| 适配器 | 实现 |
|---|---|
| pi | 手写 3 个 AgentTool：`read_file`（路径 resolve 后必须前缀匹配 cwd）、`list_dir`、`grep`（cwd 内递归文本搜索，跳过 node_modules/.git 等目录）；挂到 Agent initialState.tools |
| cc | `toolTier==='read'` 时 `--allowedTools Read,Grep,Glob`，cwd 传给 CLI |
| acp | `request_permission` 启发式应答：工具名/标题匹配只读模式（/read\|view\|grep\|glob\|search\|list\|find\|inspect\|ls/i）→ allow，否则 deny（附提示"写/执行能力即将开放"） |

安全：pi 工具的路径约束是硬边界（resolve + startsWith(cwd)），防穿越；
grep 只搜文本文件（大小上限 1MB 跳过）。

### 用量展示

- 网关新增 `POST /quota/openrouter` `{apiKey}` → 服务端 fetch
  `https://openrouter.ai/api/v1/key`（Bearer apiKey）→ 透传
  `{usage, limit, is_free_tier, rate_limit}`（不落盘、不打印 key）
- 抽屉：用量区显示 OpenRouter「已用/限额 + 免费档日请求额度」，以及每轮
  usage 事件（ACP 的 used/size = 上下文占用；pi/cc 的 token 数若可得）
- 无 key 或非 openrouter 会话：显示静态规则链接（各 provider 免费层说明）

## 期 2 设计

### 统一权限中枢（网关）

- 会话新增 pending 权限表：`{reqId, action, summary, resolve}`
- SSE 新事件：`permission_request {reqId, action, summary}`（action ∈
  write_file / bash / …）
- 新端点：`POST /sessions/:id/permission` `{reqId, decision:'allow'|'deny'}`
  → resolve 挂起的 Promise；120 秒无应答自动 deny
- 适配器获得 `requestApproval(action, summary): Promise<boolean>` 注入
  （网关实现：挂起 + SSE 推送 + 等待应答/超时）

### 三适配器接入

| 适配器 | 写/执行实现 | 确认流 |
|---|---|---|
| pi | 追加 `write_file` / `bash` AgentTool（bash 用 node:child_process，cwd 内执行，超时 60s） | execute 前先 `await requestApproval(...)` |
| cc | `toolTier==='full'` 时 CC 的 Bash/写工具经 `--permission-prompt-tool` 指向网关内置 MCP stdio 服务 | MCP 工具回调 → 网关 permission 中枢 → 抽屉 |
| acp | `request_permission` 不再启发式拒绝，全部转发抽屉 | 原生 |

cc MCP 桥：网关派生一个小型 MCP stdio 服务（`--permission-prompt-tool` 参数
指向它），CC 每次要执行非白名单动作时调用该工具；MCP 服务把请求经回环
HTTP 交给网关 permission 中枢（带共享 secret），应答回传 CC。

### 工具级别扩展

- `toolTier: 'none'|'read'|'full'`：full = 读 + 写 + Bash（均逐动作确认）
- 抽屉级别下拉新增「完整」选项；权限卡批准后该动作本会话内可选择
  「本会话记住」（减少重复确认，存于会话状态，不落盘）

## 用量展示细节

- OpenRouter：`POST /quota/openrouter` 响应 → 抽屉显示
  「已用 $X / 限额 Y · 免费档 50 req/天」或「1000 req/天（已充值）」
- 每轮 usage：turn_end 时在消息尾部追加轻量统计（token 数/上下文占用）
- 非 OpenRouter 会话：显示对应 provider 免费层说明链接

## 期 2 明确不做

- workbuddy（无接口）
- cgroup/沙箱级进程隔离（依赖外部监督）
- 跨会话记忆 / 项目索引
- 权限规则的持久化（「本会话记住」仅内存态）

## 交付物

期 1：
1. `src/config.mjs` 不变；`server.mjs` 会话 cwd/toolTier 校验与存储
2. `src/adapters/pi-tools.mjs`（read_file/list_dir/grep AgentTool 实现）+
   `pi.mjs` 接入
3. cc 适配器 allowedTools 分级
4. acp 适配器启发式权限应答
5. `POST /quota/openrouter` + 抽屉用量区
6. 抽屉 cwd 输入 + 级别下拉
7. 测试（pi 工具路径穿越/大小上限、cwd 校验、分级、配额透传）

期 2：
1. 网关 permission 中枢 + SSE 事件 + 应答端点
2. pi write_file/bash 工具 + 确认钩子
3. cc MCP 桥
4. acp request_permission 转发
5. 抽屉权限卡 UI
6. 测试

## 验证

- 期 1：pi 只读工具实测（真实目录）、cwd 穿越/不存在路径用例、配额透传、
  抽屉 UI 截图
- 期 2：写文件/执行命令逐动作确认实测（假 agent 夹具 + 真实 agent）、
  超时自动拒绝、断连清理
