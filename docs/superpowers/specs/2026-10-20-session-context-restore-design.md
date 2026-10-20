# 跨会话上下文恢复 — Design

> 状态：已与用户确认（4 节逐一通过）。下一步：`superpowers:writing-plans` 生成实现计划。

## 目标

让 Chat 抽屉的对话能跨「关抽屉 / 换标签页 / 刷新页面 / 重启网关」延续：选同样的 agent + 工作目录时，默认回到该配置下最近的会话；也可显式开新对话。解决「每次重开都是空对话、长任务要反复交代背景」的问题。

用户已确认的三项前提（brainstorming 结论）：

1. **能力不一致时自动降级**（选项 A）——能恢复的 agent（pi / cc）恢复；不能的（acp 多数）开新会话，界面上明确标注，不假装有记忆。
2. **混合模型**（选项 C）——默认自动恢复该配置下最近的会话，同时提供历史列表（5 条 + 显示更多）与显式的「＋ 新对话」按钮。
3. **落盘 + 有限期 + 可删**（选项 A）——transcript 明文落本地盘，7 天 TTL 自动清理，可单条删 / 按筛选范围清空。**apiKey 永不落盘这一性质不变。**

## 非目标

- 搜索历史内容、会话改名/置顶、导出 Markdown、跨机器同步——均可在存储层之上后加，本期不做。
- 网页端「清空全部历史」——只提供按筛选范围清空；全局清空走 CLI。网页不该有一键抹掉所有历史的权力。
- 图片的尺寸配额闸——与 Claude Code 行为保持一致，CC 自己没有这个闸（见下）。

## 关键调研结论（实现前已确认）

| 问题 | 结论 |
|---|---|
| pi 能否从 transcript 重建？ | **能。** `AgentInitialState` 接受 `messages`，`AgentState.messages` 可赋值。transcript 是纯 JSON（`role` / `content` / `timestamp` / `usage` / `stopReason`） |
| cc 能否恢复？ | **能，但有硬约束。** `--resume <id>` 只在 `CLAUDE_CONFIG_DIR` 里找 `<dir>/projects/<slug>/<id>.jsonl`，所以必须**连隔离目录一起持久化**（0.5.2 已把目录生存期改为跟随会话，本次把「会话」延伸到磁盘） |
| acp 能否恢复？ | **有条件。** SDK 有 `session/load`，但仅当 agent advertise `loadSession` capability（codex 有，其余未实测）。未实测的一律按不支持处理 |
| 图片怎么存？ | **内联 base64，与 CC 完全一致。** 实测 CC 的 transcript 就是 `{"type":"image","source":{"type":"base64","media_type":…,"data":"iVBORw0KGgo…"}}` 直接写在 JSONL 行内。实测一个 34MB 的 CC transcript 里只有 3 张图——体积主要来自长对话而非图片，故内联代价可接受，不做尺寸闸 |
| pi 的图片形状 | `{type:'image', data, mimeType}`，与 CC 的 `source.base64` 语义相同，**原样保留 `data`，不做任何丢弃** |

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
  → 前端把历史消息渲染进日志区（先显示「恢复中…」）
  → 用户发消息 → 每轮 turn_end 后同步追加写盘
```

### 新增 HTTP 接口

不改变任何现有路由的语义，纯增量：

| 接口 | 用途 |
|---|---|
| `GET /sessions?agent=&cwd=&provider=&model=` | 列出某配置下的历史会话 |
| `POST /sessions` 增可选字段 `persistId` | 带 = 恢复该会话；不带 = 新建 |
| `DELETE /sessions/:persistId` | 删单条历史（文件 + cc 目录） |
| `POST /sessions/clear` | 按 body 给定的筛选范围清空（不提供全局清空） |

`GET /sessions` 与 `POST /sessions` 同路径、按 method 区分（REST 惯例）。

### Adapter 钩子

每个 adapter 实现两个方法，能力差异自然落地：

- `restore(persistId)` → 返回该 adapter 需要的恢复材料：pi 返回 `{messages}`；cc 返回 `{configDir, ccSessionId}`；acp 返回 `null`（不支持）。
- `persist(persistId, messages)` → 把本轮新增内容写盘。

## 存储格式

### 目录结构

```
~/.config/agenttoolbox/
  config.json                 # 既有（grantedDirs）
  sessions/
    <persistId>.json          # 元数据 + pi transcript（cc 的 messages 为 null）
    <persistId>.cc/           # cc 的隔离 config dir（CLI 自己写 transcript 的地方）
```

`persistId` 用 UUID。文件名即 id，读目录即列表——不需要额外索引文件，少一个会不一致的状态源。

### 单文件格式

```jsonc
{
  "v": 1,                        // 格式版本；认不出的按损坏处理，绝不猜测
  "id": "9f3c…",
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
- 落盘位置在 `~/.config/agenttoolbox/`，与 `config.json`（grantedDirs）同目录，同受 `ATBX_CONFIG_PATH` 覆盖（测试重定向亦靠它）。

## 测试策略

| 层 | 测什么 |
|---|---|
| `transcript-store.test.mjs`（新） | 写 / 读 / 列 / 删、TTL 清扫、损坏文件降级、版本迁移、权限位、原子写 |
| `cc-adapter.test.mjs`（扩） | `restore()` 返回 config dir 路径 + session id；目录没了返回 null |
| `pi-adapter.test.mjs`（扩） | `restore()` 把 messages 喂进 `initialState`，第二轮上下文含第一轮内容（仿既有 multi-turn 用例） |
| `server.test.mjs`（扩） | `GET /sessions` 列表、带 `persistId` 创建、409 并发拒绝、`DELETE`、`clear` |
| 端到端（真实 CLI） | 跑两轮 → 杀网关 → 重启 → 恢复 → 第三轮记得第一轮 |

最后一条不可省：**它是唯一能证明「跨进程恢复」真的 work 的测试**，前四个都只在单进程内自证。

## 已知代价（如实记录）

1. **磁盘占用**：带图会话可达数 MB；长对话本身是主要驱动（参照：本地一个 CC transcript 34MB）。
2. **写入放大**：每轮一次全量写盘。长会话（几百条消息）时是几百 KB ~ MB 级写入。可接受，但若将来会话规模上涨需改为增量追加。
3. **行为不一致**：acp  agent 无记忆。这是选项 A 的既定取舍，靠 UI 标注缓解，无法根除。
4. **并发保护是粗粒度**：409 拒绝而非合并。两个标签页协同用同一会话会被拒，需手动刷新。
