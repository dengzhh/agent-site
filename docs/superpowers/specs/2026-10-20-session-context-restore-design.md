# 跨会话上下文恢复 + 本机原生会话互通 — Design

> 状态：已与用户确认（brainstorming 4 节 + 统一管理补充）。下一步：`superpowers:writing-plans` 生成实现计划。

## 目标

两件事，按同一套存储解决：

1. **跨会话恢复** —— Chat 抽屉的对话能跨「关抽屉 / 换标签页 / 刷新页面 / 重启网关」延续：选同样的 agent + 工作目录时，默认回到该配置下最近的会话；也可显式开新对话。解决「每次重开都是空对话、长任务要反复交代背景」的问题。
2. **与本机原生 agent 互通** —— 网站开的会话，本机终端里的 `claude` / `pi` 能打开续上；反方向至少可见。用户原话：「网站开启的会话是否可以与本地原生 agent 如 cc 和 pi 的会话纳入统一管理，彼此都能看到，本地会话可以在网站打开和恢复」。

用户已确认的决策：

1. **能力不一致时自动降级**（选项 A）——能恢复的 agent 恢复；不能的开新会话，界面上明确标注，不假装有记忆。
2. **混合模型**（选项 C）——默认自动恢复该配置下最近的会话，同时提供历史列表（5 条 + 显示更多）与显式的「＋ 新对话」按钮。
3. **落盘 + 有限期 + 可删**（选项 A）——transcript 明文落本地盘，7 天 TTL 自动清理，可单条删 / 按筛选范围清空。**apiKey 永不落盘这一性质不变。**
4. **统一管理分两步走**（选项 C）——本期做「单向可见 + 双向可恢复」，pi 适配器重写（spawn CLI 换掉进程内库）作为独立后续项目。理由见下「pi 互通的两个方向」。
5. **图片完整保存**，与 Claude Code 一致（内联 base64）。

## 非目标

- 搜索历史内容、会话改名/置顶、导出 Markdown、跨机器同步——均可在存储层之上后加，本期不做。
- 网页端「清空全部历史」——只提供按筛选范围清空；全局清空走 CLI。网页不该有一键抹掉所有历史的权力。
- 图片的尺寸配额闸——与 Claude Code 行为保持一致，CC 自己没有这个闸。
- **pi 适配器改为 spawn CLI**（即「网站直接跑本机 pi CLI」）——本期不做，是独立的后续项目。本期网关继续用进程内 `pi-agent-core` 库。
- acp 的跨会话互通——各 agent 存储格式互不相同，无统一路径。

## 关键调研结论（实现前已确认）

| 问题 | 结论 |
|---|---|
| pi（库）能否从 transcript 重建？ | **能。** `AgentInitialState` 接受 `messages`，`AgentState.messages` 可赋值。transcript 是纯 JSON（`role` / `content` / `timestamp` / `usage` / `stopReason`） |
| pi-agent-core 库自己有磁盘能力吗？ | **完全没有。** 全库无 `node:fs` 引用；`sessionId` 只在 payload 里透传（`agent.js:308`），从不落盘。这是「必须自己实现序列化」的根本原因 |
| 本机 `pi` CLI 的存储格式？ | `~/.pi/agent/sessions/<cwd-slug>/<时间戳>_<uuid>.jsonl`，**事件日志**（`session` / `model_change` / `thinking_level_change` / `message`，带 `parentId` 链），不是扁平消息数组 |
| cc 能否恢复？ | **能，但有硬约束。** `--resume <id>` 只在 `CLAUDE_CONFIG_DIR` 里找 `<dir>/projects/<slug>/<id>.jsonl`，所以必须**连隔离目录一起持久化**（0.5.2 已把目录生存期改为跟随会话，本次把「会话」延伸到磁盘） |
| acp 能否恢复？ | **有条件。** SDK 有 `session/load`，但仅当 agent advertise `loadSession` capability（codex 有，其余未实测）。未实测的一律按不支持处理 |
| 图片怎么存？ | **内联 base64，与 CC 完全一致。** 实测 CC 的 transcript 就是 `{"type":"image","source":{"type":"base64","media_type":…,"data":"iVBORw0KGgo…"}}` 直接写在 JSONL 行内。实测一个 34MB 的 CC transcript 里只有 3 张图——体积主要来自长对话而非图片，故内联代价可接受，不做尺寸闸 |
| pi 的图片形状 | `{type:'image', data, mimeType}`，与 CC 的 `source.base64` 语义相同，**原样保留 `data`，不做任何丢弃** |

### pi 互通的两个方向（2026-10-20 实测）

用真实 `pi` CLI 验证，这决定了为什么选「分两步走」：

| 方向 | 可行性 | 实测依据 |
|---|---|---|
| **网站会话 → 本机 CLI 打开** | ✅ **可行，本期做** | `pi --session-dir <共享目录> --session <id> "…"` 成功重放我们写入的会话；`--fork <id>` 可从不同 cwd 非交互续上（实测从 `/tmp` fork `/home/dengzh` 的会话，模型正确回忆出上一轮的数字 42） |
| **网站直接跑本机 pi CLI** | ⚠️ 可行但代价大，**后续项目** | CLI 有完整能力（`--session` / `--continue` / `--fork` / `--session-dir` / `--tools` / `--mode json`），但要求 pi 适配器从「进程内库」重写为「spawn CLI 子进程」：事件流要从 CLI 的 json 事件（`agent_start`/`turn_start`/`message_start`/`message_end`）重新解析；**full tier 的审批卡机制要重新设计**（权限在 CLI 自己那边，headless 下可能弹交互卡住）；工具集从我们有路径边界检查的 `readOnlyTools`/`fullTools` 换成 CLI 内置工具 |
| **本机 CLI 会话 → 网站恢复** | ❌ **本期不做** | 格式是事件日志 + `parentId` 链，喂不回库的 `initialState.messages`。只能读取展示，不能真正恢复上下文。做了会给人「能恢复」的假象，违背「不假装」原则 |

**pi 的 cwd 强约束**（实测）：`pi --session <id>` 拒绝恢复 cwd 不符的会话，交互式询问「Session found in different project: … Fork this session into current directory? [y/N]」。故网站写入共享目录时**必须原样保留会话的 cwd**，让用户在本机对应目录下能直接 resume；跨目录时用 `--fork`（非交互）。

### 统一管理的最终形态

| Agent | 网站开的会话，本机能打开？ | 本机开的会话，网站能恢复？ | 本期 |
|---|---|---|---|
| **cc** | ✅ 指向持久 `CLAUDE_CONFIG_DIR` 后天然互通 | ✅ 同一份 jsonl | **双向** |
| **pi** | ✅ 写共享目录，CLI `--session` / `--fork` 打开 | ❌ 事件日志喂不回库 | **单向（网站→CLI）** |
| **acp** | ❌ 各 agent 格式不一 | ❌ | **无** |


## 架构

把「会话」从纯内存对象提升为**有磁盘身份**的东西，分两层：

- **SessionStore（内存，既有）** —— 活跃会话的 LRU + TTL。在途回合、挂起审批、SSE 连接挂在这。**行为不变。**
- **TranscriptStore（磁盘，新增）** —— `~/.config/agenttoolbox/sessions/` 下每会话一个文件。内存会话被逐出时**不再删除内容**，只从内存消失。

**稳定身份 `persistId`**：`POST /sessions` 时生成或复用，此后无论内存会话怎么重建都指向同一份磁盘 transcript。前端存 `localStorage`。

### 数据流（恢复一个旧会话，以 pi 为例）

```
前端 openChat(config)
  → GET /sessions?agent=&cwd=&provider=&model=     返回该配置下的历史列表（含 persistId、标题、时间、消息数、canRestore）
  → 默认取最近一条，POST /sessions {persistId, ...config, apiKey}
      → 网关发现 persistId 已有磁盘记录
      → pi : 读 transcript.json → new Agent({initialState:{messages}})   上下文回来
      → cc : 保留的 config dir 还在 → --resume <ccSessionId>
      → acp: restore 返回 null → 开新会话，列表里那条标「不支持恢复」
      → 恢复成功时响应带 {resumed:true, messages, title}——前端不必再发一次
        请求去取历史（省一轮往返，也让「恢复中…」占位有明确的结束点）
  → 前端把历史消息渲染进日志区（先显示「恢复中…」）
  → 用户发消息 → 每轮 turn_end 后同步追加写盘
```

### 新增 HTTP 接口

不改变任何现有路由的语义，纯增量：

| 接口 | 用途 |
|---|---|
| `GET /sessions?agent=&cwd=&provider=&model=` | 列出某配置下的历史会话 |
| `POST /sessions` 增可选字段 `persistId` | 带 = 恢复该会话（响应加 `resumed`/`messages`/`title`）；不带 = 新建。该 id 已有活跃内存会话 → 409 |
| `DELETE /sessions/:persistId` | 删单条历史（文件 + cc 目录） |
| `POST /sessions/clear` | 按 body 给定的筛选范围清空（不提供全局清空） |

`GET /sessions` 与 `POST /sessions` 同路径、按 method 区分（REST 惯例）。

### Adapter 钩子

每个 adapter 实现两个方法，能力差异自然落地：

- `restore(sessionId)` → 返回该 adapter 需要的恢复材料：pi 返回 `{messages}`；cc 返回 `{configDir, ccSessionId}`；拿不到（记录没了 / 依赖物没了 / agent 不支持）一律返回 `null`，由上层开新会话。
- `disposeSession(sessionId)` → 会话终结时回收磁盘记录（含 cc 的 config dir）。
- 持久化没有独立钩子：适配器在每轮 `turn_end` 后自行调 `store.save()`（它才知道自己这轮产出了什么），失败只记日志不影响回合。

## 存储格式

### 目录结构

```
~/.config/agenttoolbox/
  config.json                 # 既有（grantedDirs）
  sessions/                   # 网站会话的统一存储（下详）
    <persistId>.json          # 元数据 + pi transcript（cc 的 messages 为 null）
    <persistId>.cc/           # cc 的持久 config dir（CLI 自己写 transcript 的地方）
```

`persistId` 用 UUID。文件名即 id，读目录即列表——不需要额外索引文件，少一个会不一致的状态源。

### 与本机 pi CLI 共享目录

网站开的 pi 会话，**除 `<persistId>.json` 外，再写一份 pi CLI 原生格式**到共享目录，让本机能打开：

```
~/.pi/agent/sessions/                                    # pi CLI 的默认位置（不改它）
  --home-you-proj--/                                     # cwd slug（CLI 自己的命名规则）
    <时间戳>_<piSessionId>.jsonl                         # 事件日志格式
```

关键点：

- **`piSessionId` 与 `persistId` 分开**。`persistId` 是我们的 UUID（文件名、恢复键）；`piSessionId` 是我们为这次对话生成的第二个 UUID，写进 pi 格式 JSONL 的 `session` 行。两个 id 的映射存在 `<persistId>.json` 里（`piSessionId` 字段）。
- **cwd 原样保留**在 JSONL 的 `session` 行里——pi CLI 强制 cwd 一致才允许原地 resume（实测：不符就交互式问要不要 fork）。用户在本机对应目录下 `pi --session <piSessionId>` 直接续上；跨目录用 `pi --fork <piSessionId>`。
- **只写不读**。我们不解析 `~/.pi/agent/sessions/` 下 CLI 自己建的会话（格式是事件日志 + `parentId` 链，喂不回库的 `messages`）。网站「统一管理」里那些会话不出现——这是本期「单向」的确切边界。
- 共享目录位置可由 `ATBX_PI_SESSION_DIR` 覆盖；缺省用 pi CLI 自己的默认值，保证用户不改任何配置就能互通。

### 单文件格式

```jsonc
{
  "v": 1,                        // 格式版本；认不出的按损坏处理，绝不猜测
  "id": "9f3c…",                 // = persistId
  "adapter": "pi",               // 决定 restore 走哪条路
  "agent": "pi",                 // 用户在抽屉里选的（'pi' | 'cc' | 'acp:hermes'…）
  "provider": "zai",
  "model": "glm-4.7-flash",
  "cwd": "/home/you/project",
  "toolTier": "full",
  "title": "写一个贪吃蛇",        // 首条用户消息截断，列表里显示
  "createdAt": 1761000000000,
  "lastUsed": 1761003600000,     // 每轮 turn_end 刷新；TTL 的依据
  // pi 适配器：完整 transcript（含图片 base64）。cc/acp：null。
  "messages": [ … ],
  // 仅 pi：写到共享目录的 pi CLI 会话 id（本机 pi --session/--fork 用它）。
  // 缺省/null = 未写共享目录（例如 tier 为 none 或用户关掉了互通）。
  "piSessionId": null,
  // 仅 cc：CLI 的 session id，--resume 要用。内容本身在 <id>.cc/ 里（CLI 自己写），
  // 故不在此重复。恢复时 restore() 返回 {configDir, ccSessionId} 两个材料。
  "ccSessionId": null
}
```

**刻意不存的字段**：

- `apiKey` —— 性质不变，永远从浏览器来，每次请求带上。
- `canRestore` —— **不存布尔值，每次现算**。cc 的恢复依赖隔离目录还在，而目录可能被 TTL 清掉、被手动删、被系统清理工具扫走。存一个布尔字段只会变成谎言。

### 权限

transcript 含敏感内容（full tier 的工具输出、截图、代码），故：

- 文件 `0600`（仅属主可读写），目录 `0700`。与 CC 自己的 transcript（`-rw-------`）一致。

### 原子写

先写 `<id>.json.tmp` 再 `rename` 覆盖。进程在写一半时被杀，不会留下半截 JSON。

## TTL 与清理

| 事件 | 行为 |
|---|---|
| 每轮 `turn_end` | `lastUsed` 刷新（同步写盘） |
| 网关启动时 | 扫一遍，删掉 `lastUsed` 超过 7 天的（文件 + `.cc/` 目录） |
| 会话被内存 LRU 逐出 | **不再删**，只从内存消失 —— 本次改动的核心 |
| 用户点删除 / 按范围清空 | 立即删 |

7 天按「隔天继续干活」定。`ATBX_SESSION_TTL_DAYS` 可覆盖。

**写入时机**：每轮 `turn_end` 后同步追加。一个回合几十秒，中途崩丢半轮可接受；同步写保证「你看到回复了，它就一定在盘上」。带图的那轮写盘是几百 KB 级，感知不到。

## 前端交互

### 抽屉结构

在 Agent 行与配置行之间插入「会话」行，**跨面板常驻**（安装引导 / key 面板时也能看到和操作）：

```
┌─────────────────────────────────┐
│ GLM-4.7-Flash                ✕  │
│ zai · glm-4.7-flash              │
├─────────────────────────────────┤
│ Agent      [ Claude Code    ▾ ]  │  ← 既有
├─────────────────────────────────┤
│ 会话              [＋ 新对话]     │  ← 新增
│  ┌─────────────────────────────┐ │
│  │ ▸ 写一个贪吃蛇      2小时前   │ │  ← 默认选中（该配置下最近）
│  │   改一下得分显示     昨天  🗑  │ │
│  │   …（5 条）      [显示更多]   │ │
│  └─────────────────────────────┘ │
├─────────────────────────────────┤
│ Work dir   [ /home/you/proj   ]  │  ← 既有
│ Tier       [ + Read & run    ▾ ]  │  ← 既有
├─────────────────────────────────┤
```

### 行为

- **默认恢复**：`openChat()` 时查列表，该配置下有历史 → 自动恢复最近一条，日志区直接显示历史消息（不是空白）。
- **＋ 新对话**：显式开全新会话，`persistId` 置空。这是避免上下文污染的关键出口——一个目录下常有多个话题（写游戏 vs 改 README），没有这个按钮用户会被动陷入上下文污染且不知为何。
- **列表筛选键**：`agent + cwd + provider + model`。与 pi 适配器既有的 `cacheKey` 四维度一致（`pi.mjs`），换模型不会串到别的模型的历史里。
- **列表长度**：默认 5 条 + 「显示更多」。
- **不支持恢复的呈现**：acp 那条历史正常显示，右侧带 `⟲` 标记 + tooltip「该 agent 无法恢复上下文，点它将开始新对话」。点击后正常打开但内容为空。**不隐藏、不报错、不假装。**
- **本机互通的提示**：pi / cc 的会话详情里显示一行「本机可用 `pi --session <id>` / `claude --resume <id>` 继续」+ 一个复制按钮（复制完整命令，含共享目录参数）。这是「统一管理」在 UI 上唯一需要的出口——用户不需要在网页里做任何事，只需要知道命令是什么。id 显示为短前缀（前 8 位），完整值在复制的内容里。
- **删除**：每条旁删除按钮；列表底部「清空该目录的全部历史」（仅当前筛选范围）。全局清空走 CLI。
- **恢复提示**：恢复旧会话时在对话最前面插一条分隔提示「— 已恢复 2 小时前的对话，N 条消息 —」，明确告知现在带着历史上下文。
- **避免闪烁**：日志区先显示「恢复中…」，历史渲染完再替换。历史通常几十条、渲染毫秒级，但先占位行为更干净。

## 边界情况

| 情况 | 处理 |
|---|---|
| cc 的隔离目录没了（TTL / 手动删 / 系统清理） | `canRestore` 现算为 false，列表标注；点击则开新会话 |
| 两个标签页同时恢复同一 `persistId` | `POST /sessions` 检测到该 id 已有活跃内存会话 → **409 `session already active`**，前端转新会话。牺牲一点便利换数据一致性 |
| transcript 损坏 / JSON 解析失败 | 当作「没有历史」开新会话；坏文件移到 `<id>.corrupt.json` 而非删除（用户可能想抢救） |
| 格式版本认不出 | 按损坏处理，**绝不猜测形状** |
| cwd 不存在了 | 元数据照常显示；点击恢复时 `POST /sessions` 因 cwd 校验 400 —— 该错误路径已存在且处理良好（错误进日志、停在主面板），无需新代码 |
| 空目录 + read/full tier | 既有行为：客户端把 tier 归一为 none 并提示。不受本次影响 |

## 安全边界

- **apiKey 永不落盘**，这一性质没有任何松动。key 只走 浏览器 → 请求体 → 内存。
- transcript 明文落盘意味着**接受敏感内容落盘**：full tier 的工具输出、读过的文件内容、跑过的命令、截图。缓解是 7 天 TTL + 单条删除 + 按范围清空 + `0600` 权限。用户已在 brainstorming 中明确接受此取舍。
- 落盘位置在 `~/.config/agenttoolbox/`，与 `config.json`（grantedDirs）同目录。三个环境变量：`ATBX_SESSION_TTL_DAYS`（TTL 天数）、`ATBX_PI_SESSION_DIR`（pi 共享镜像目录）、`ATBX_SESSION_DIR`（覆盖 sessions 目录本身，测试与终端子命令靠它重定向）。

## 测试策略

| 层 | 测什么 |
|---|---|
| `transcript-store.test.mjs`（新） | 写 / 读 / 列 / 删、TTL 清扫、损坏文件降级、版本迁移、权限位、原子写 |
| `pi-session-writer.test.mjs`（新） | 我们的 transcript → pi CLI 原生 JSONL 的形状正确性（`session` 行的 cwd/version/id、message 行的 role/content、`parentId` 链连续）、图片 base64 原样保留 |
| `cc-adapter.test.mjs`（扩） | `restore()` 返回 config dir 路径 + session id；目录没了返回 null |
| `pi-adapter.test.mjs`（扩） | `restore()` 把 messages 喂进 `initialState`，第二轮上下文含第一轮内容（仿既有 multi-turn 用例） |
| `server.test.mjs`（扩） | `GET /sessions` 列表、带 `persistId` 创建、409 并发拒绝、`DELETE`、`clear` |
| 端到端（真实 CLI） | ① 跑两轮 → 杀网关 → 重启 → 恢复 → 第三轮记得第一轮（跨进程恢复） |
| 端到端（真实 pi CLI） | ② 网站写一个会话 → `pi --session-dir <共享目录> --session <piSessionId> "…"` 能续上并答对上下文（网站→CLI 方向） |

①②两条不可省：

- ① 是唯一能证明「跨进程恢复」真的 work 的测试，前四个都只在单进程内自证。
- ② 是唯一能证明「本机能打开网站会话」的测试——写出的 JSONL 形状对不对，只有真 CLI 说了算。（实测过手动构造的最小样例能被 resume，故格式是抓得准的；测试把它固化成回归。）

## 已知代价（如实记录）

1. **磁盘占用**：带图会话可达数 MB；长对话本身是主要驱动（参照：本地一个 CC transcript 34MB）。
2. **写入放大**：每轮一次全量写盘。长会话（几百条消息）时是几百 KB ~ MB 级写入。可接受，但若将来会话规模上涨需改为增量追加。
3. **行为不一致**：acp agent 无记忆；本机 CLI 开的 pi 会话网站看不到（只单向）。这是既定取舍，靠 UI 标注缓解，无法根除。
4. **并发保护是粗粒度**：409 拒绝而非合并。两个标签页协同用同一会话会被拒，需手动刷新。
5. **pi 格式是逆向对齐的**：pi CLI 的 JSONL 是事件日志（`parentId` 链），我们只写不读，靠测试 ② 兜住形状漂移。CLI 升级改格式时，测试会红——这是有意设计的预警，不是缺陷。
6. **两份副本**：pi 会话同时存 `<persistId>.json`（我们读）和共享目录 JSONL（CLI 读），内容重复。换来的是两边都能用，没找到只存一份且两边都认的格式。

