# 测试夹具与各 agent 实测记录

## 夹具

| 文件 | 用途 |
|---|---|
| `fake-acp-agent.mjs` | 最小 ACP 服务端：应答 initialize/session/new/prompt，推送 thought→message→usage 通知再回 end_turn。`FAKE_ACP_MODE=error` 回 error stopReason |
| `fake-claude.sh` / `fake-claude-hang.sh` | cc 适配器夹具 |
| `cc-turn-holder.mjs` | cc 孤儿进程测试用（扮演持有一轮 turn 的网关） |
| `cc-echo-argv.sh` | cc 适配器 argv 回显：每个参数回显为 `ARG=<值>` delta，断言 tier → 命令行参数映射 |
| `fake-claude-perm.mjs` | cc 权限回合夹具（Task 11）：回合中点发 `control_request(can_use_tool)`，等 stdin 的 `control_response`，按 behavior 回 `RESP=<原始应答行>` + `allowed`/`denied` delta。`FAKE_PERM_ID/TOOL/INPUT` 控制请求内容；15s 无应答或 stdin 提前关闭回 error result |

## 各 agent ACP 实测记录（2026-10-07 / 10-09）

| agent | 探活 | 端到端 | 备注 |
|---|---|---|---|
| **hermes** | ✅ | ✅ **完整跑通** | 流式 delta、思维链、usage_update、end_turn 全部正确。错误示例见下 |
| **codex** | ✅（npx） | ✅ **initialize 握手成功** | 应答 protocolVersion 1 + capabilities（loadSession/resume/close）；auth 支持 `CODEX_API_KEY` env。完整 turn 未测（需 ChatGPT 订阅或 API key） |
| **openclaw** | ✅ | ❌ **超时** | 其 ACP 桥需要 OpenClaw Gateway（ws://127.0.0.1:18792）先运行；Gateway 未起时桥静默等待。**UI 引导：需先 `openclaw gateway` 启动** |
| **dsh** | ✅（npx） | ⏳ 未完成 | 分类器拦截了对 npx 第三方包的探针；SDK schema 已确认其 ACP 实现是官方一等公民（`dsh --profile acp`），待环境允许时补测 |
| **opencode** | ❌ 未装 | — | 本机无 CLI；装了即按同一适配器路径工作 |

错误信息示例（hermes，上游模型配置问题而非适配器问题）：
`API call failed after 3 retries: HTTP 404: No endpoints found for qwen/qwen-max.`
→ 协议层（流式、用量、end_turn）工作正常。

## 已知注意事项

- **openclaw**：`openclaw acp` 是 Gateway-backed 桥接，不是独立服务。无 Gateway 时
  需要先运行 `openclaw gateway`（或让用户知道这一前置）。
- **hermes**：stderr 日志噪声极大（插件注册/警告），适配器已将其排空而非转发。
- **codex**：`CODEX_API_KEY` / `OPENAI_API_KEY` 环境变量认证；无法用自定义 baseURL
  （`wire_api` 仅支持 responses 协议）。
- **dsh**：`DSH_HOME` 隔离配置（0.2.0-rc.2，API 可能变动）。

## 期 1 端到端实测（2026-10-18，工作目录 + 工具分级）

环境：网关 31415（本包源码直启）+ astro dev + 真实 `claude` / `hermes` CLI，
浏览器实测 Chat 抽屉。截图存档：`/tmp/atbx-e2e-screens/agent-execution-task7-e2e-drawer.png`（未入库）。

| 验证点 | 结果 |
|---|---|
| 配置行渲染 + 持久化 | ✅ 抽屉出现 Work dir 输入框与 Chat only / + Read files 下拉；cwd+tier 写入 localStorage，重开抽屉后恢复 |
| 无效 cwd（`/no/such/dir-xyz-e2e`）+ read | ✅ 网关 400 → 聊天日志显示错误行，抽屉停留在主面板；网关日志确认 `POST /sessions` **未创建会话** |
| 空 cwd + read | ✅ 客户端把 tier 强制归一为 `none`（下拉同步归一 + hint 提示行）；网关日志确认以 `tier=none cwd=-` 建会话 |
| 有效 cwd（`/tmp/atbx-e2e`）+ read | ✅ 建会话成功；网关日志 `cwd=/tmp/atbx-e2e tier=read`；claude 子进程带 `--allowedTools Read,Grep,Glob` 启动（分级在进程级落地） |
| 流式状态机 | ✅ 回合中 Send 禁用 + Stop 显示；Stop → 网关 `/abort` → claude 子进程被杀 → `[connection closed]` 行 → Send 恢复 |
| OpenRouter 额度查询 | ✅ 每次建会话后触发 `POST /quota/openrouter`；占位 key → 上游 401 → 用量行保持空白（优雅降级） |

**已知阻塞（如实记录）**：本轮环境里「agent grep 文件并引用内容」的完整回合
**未跑通** —— cc 适配器把目录里的模型 id（`thinkingmachines/inkling-small:free`）
原样传给 claude CLI，CLI 警告 `[claude-code:unrecognized_model]` 后回合挂在
所配置的上游（测试环境里由 Claude Code 注入的 `ANTHROPIC_BASE_URL` 代理）。
这是模型目录 / cc 适配器的集成问题，不在 Task 7/8 范围内；`acp:hermes` 路径
同样卡在其自身上游。服务端工具管线（tier/cwd/allowedTools 断言）已由自动化
测试套件覆盖。

## 期 2 权限卡真机实测（2026-10-19，Task 13 遗留项补测）

环境：网关 31415（源码直启，保留 GLM 代理 env）+ astro dev（/agent-site）+
真实 `claude` CLI（full tier，stream-json 控制通道）+ playwright 驱动 Chat 抽屉。
上游走抽屉的 Z.AI/GLM-4.7-Flash 卡（`anthropicApi=api.z.ai/api/anthropic` +
本机 GLM token；`open.bigmodel.cn` 与 `api.z.ai` 两个 Anthropic 兼容端点均实测
200，抽屉无自定义 baseUrl 输入，故走 provider 卡）。截图存档：
`/tmp/atbx-e2e-screens/task13-*.png`（未入库）。

| 验证点 | 结果 |
|---|---|
| tier 下拉含 full（"+ Read & run tools"） | ✅ 空 cwd 选 read/full → 归一 `none` + 提示行；full 为瞬态选择，未写入 localStorage |
| cwd/tier 持久化 | ✅ 刷新页面重开抽屉后 `atbx:cwd` / `atbx:tier=full` 恢复 |
| Approve 流程 | ✅ cc full 首回合 ~25s 出权限卡（BASH 动作 + 命令摘要）；Approve → 卡片 `is-approved`，回合完成，目标文件落盘且内容精确匹配 |
| Deny 流程 | ✅ Deny（双击）→ `is-denied`；CLI 收到 `denied by user`，文件未创建，助手回复确认被拒 |
| 防重/防御 | ✅ 双击 Deny 仅产生一次 `POST /permission`（网络日志证实）；结算后按钮替换为状态标签，陈旧卡结构性不可再点 |
| 控制台 | ✅ 全程无应用 JS 错误（仅外部 Google Fonts 加载失败，与本站无关） |

**已知问题（如实记录，非 Task 13 回归）**：cc 会话第 2 条消息立即报
`[error] Claude Code error` —— 即已立项跟踪的「cc 跨 turn resume 修复」：
每 run 新建并随即删除隔离 `CLAUDE_CONFIG_DIR`，却仍传 `--resume` 旧 id，resume
必败。测试以「改配置重建会话」绕过。顺带观察：错误行无细节文本（可读性欠佳）；
助手气泡把 markdown 反引号按字面渲染（既有外观问题）。

