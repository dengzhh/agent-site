# cc 的会话历史上网页 + 历史不按模型分格 — Design

> 状态：已与用户确认（brainstorming 第 1-6 节）。下一步：`superpowers:writing-plans` 生成实现计划。

## 目标

两件事，同一个抽屉：

1. **cc 的历史在网页里可见** —— 现在选 Claude Code agent 只能看到一行「已接上本机的 Claude Code 会话（历史不在网页里显示）」。要把 cc 自己那份对话（思维链 + 正文）读出来，渲染在日志区，与 pi 的表现一致。
2. **换模型不换历史** —— 用户原话：「切换模型后如果没有换 agent，那会话历史应该不变」。现在 `GET /sessions` 按 `agent/cwd/provider/model` 四维筛选，模型是其中一维，于是从 GLM 卡切到 Claude 卡（甚至同一 provider 的两个模型）历史就整排消失。

## 非目标

- 改 pi 的恢复路径（它本来就把 `rec.messages` 喂回 `initialState.messages`，跨模型已通）。
- 改 cc 的 `--resume` 语义（模型由本次请求决定，CLI 原生行为）。
- 历史内容搜索、会话改名/置顶、导出 Markdown（同 2026-10-20 的 spec，仍是后话）。
- 修「pi 跨 provider 恢复时旧模型写的块可能不被新 provider 接受」这个既有风险——见下面「已知风险」，本期只把它写进文档，不动手。

## 关键调研结论（实现前已实测）

| 问题 | 结论 |
|---|---|
| cc 的 transcript 长什么样？ | `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`，每行一个 JSON 事件。实测一份真实文件：26 行 / 213.3 KB，其中**对话只有 3 行 / 433 字符**（占 0.2%），其余是 `attachment`（11 行）、`api-request-blob`（2 行，其中一行带 8474 字符的 system prompt）等噪声行 |
| 怎么认出对话行？ | **按 `type` 字段：`type ∈ {user, assistant}` 才是对话。** 不能按 `message.role` 筛——`api-request-blob` 之类的噪声行同样带 role，会把 8 KB 的 system prompt 当成用户消息渲染出来 |
| cc 的 content block 要转换吗？ | **不要。** 实测 cc 写的就是 Anthropic 标准形状 `{type:'text',text}` / `{type:'thinking',thinking}`，与 pi 存进 `rec.messages` 的形状逐字段一致。直接透传即可 |
| 读这份文件贵吗？ | **不贵。** 恢复是**一次性**动作（不是每轮），且只需要对话行。上面那份 213 KB 的文件，读完整文件 + 挑出 3 行 ≈ 一次普通文件读。**刻意不每轮读、也刻意不把内容搬进我们的记录**——记录只留 `configDir` + `ccSessionId` 两个指针（`9e35bb7` 起就是这样），内容继续由 CLI 保管 |
| 换模型串历史的顾虑成立吗？ | **不成立。** 两个可恢复适配器都不按模型分格：pi 的 `loadPersistedMessages`（`pi.mjs:125`）只校验 `rec.adapter === 'pi'`，messages 喂进 `initialState.messages`、Agent 用新模型重建；cc 的 `--resume <ccSessionId>` 天然跨模型。`model` 进筛选只是因为 `server.mjs:178` 的注释写「筛选四维与 pi 的 cacheKey 一致」——而 `cacheKey`（`pi.mjs:99`）是**内存 Agent 缓存**的键，与「历史属于谁」是两个问题 |

## 架构

### 第一部分：cc 的 restore 把历史一起带回来

全部改动在 `adapter.restore()` 一个函数里，**对外零接口变更**：

```
POST /sessions {persistId, model: 新模型}
  → cc.restore(id)
      → 找到 <configDir>/projects/<slug>/<ccSessionId>.jsonl
      → 逐行 JSON.parse，只留 type ∈ {user, assistant}，取 message.content 原样返回
      → { configDir, ccSessionId, messages: [...] }
  → server 已把 material.messages 塞进响应（既有契约，见 server.mjs:311）
  → 前端 ensureSession 已会渲染 res.messages（既有代码，见 free-models.astro:743）
```

`POST /sessions` 的响应契约、前端渲染循环都已存在且已为 pi 工作——本部分**不需要动协议、不需要动前端结构**，只补三处细节：

（前端渲染循环本身也要小改——思维链不再显示成 `[thinking]`。那属于「前端：思维链的渲染」一节，不属于这里的「零接口变更」：接口确实不变，变的是界面怎么画这些已有的块。）

**1. 形状对齐（无需转换）**
cc 的 `message.content` 就是 `[{type:'text'|'thinking', …}]`，与 pi 的 `rec.messages` 同形。`restore()` 直接把数组返回，不做任何整形。

**2. 只在恢复时读，绝不每轮读、绝不落我们的盘**
`restore()` 在 `POST /sessions` 时被调一次（`server.mjs` 的 `material` 那处）。turn 过程中不读，也不把内容写进 `<id>.json`。理由：
- 内容只有一份权威副本（CLI 的 jsonl），我们存第二份就有了两个可能不一致的真源；
- 每轮读一遍是白工——那一轮的 delta 已经通过 SSE 给了前端；
- 记录保持现在的指针形态（`configDir` + `ccSessionId`），`9e35bb7` 的 `spoke()` 判据不受影响。

**3. 优雅降级，不假装有历史**
`restore()` 失败（jsonl 不存在 / 读不了 / 一行都不像对话）时返回 `{configDir, ccSessionId}`（与现在完全一样，`--resume` 照常续上下文），前端照现在的提示走：「已接上本机的 Claude Code 会话（历史不在网页里显示，下一轮会接着它的上下文）。」**绝不返回空数组**——那会让前端画出「已恢复历史对话，0 条消息」的假横幅，比不显示更糟。

### 第二部分：筛选从四维降到两维

`GET /sessions` 与 `POST /sessions/clear` 只按 `{agent, cwd}` 筛。

| 维度 | 处置 | 理由 |
|---|---|---|
| `agent` | **保留筛选** | 真实边界。pi 与 cc 的上下文互不相通（`chat-agent` 的 change handler 注释也这么写），跨 agent 恢复没有意义 |
| `cwd` | **保留筛选** | 项目边界。空 cwd 时网关本就不筛（前端另有拦截，见下） |
| `provider` | **退出筛选，仍写入记录** | 本站模型卡片是 `data-provider` + `data-model` 同一个 `chat-pick`，只去 `model` 的话「GLM 卡 → Claude 卡」照样丢历史，抱怨原样复发 |
| `model` | **退出筛选，仍写入记录** | 用户新要求。两个可恢复适配器都不按模型分格（见调研表） |

`provider`/`model` 仍是记录字段（`RECORD_FIELDS` 白名单不动），`POST /sessions` 的 existing 分支继续逐字段合并写入——恢复时它们更新成「最近一次用什么跑的」，即从**筛选键降级为展示元数据**。这也是列表行加模型小标的原因（见下）。

**连带的三处**：

1. **自动恢复自动满足新要求**：`ensureSession` 的 `list.find(canRestore)?.id` 变成「同 agent 同目录下最近一条说过话的」。换模型进 chat → 接上同一条会话，这回由新模型答。要全新对话有现成的「＋ 新对话」按钮（`persistId: null`）。
2. **清空按钮的文案终于诚实了**：按钮写的是「清空此目录的历史」，改后它真的只按「此目录」（+ agent）清，不再偷偷多带一个模型条件。拦截逻辑不变（`!c.cwd` 时仍拦住：空 cwd 下网关不筛 cwd，会清掉所有项目的历史）。
3. **列表行加模型小标**（`renderSessionList` 里加一个 span，取记录已有的 `s.model`）：筛选不再按模型分格，列表里会混着不同模型的会话，标出来才知道这条上次是谁跑的。模型名与标题同排、弱化样式，不抢标题。

### 前端：思维链的渲染

`ensureSession` 的恢复渲染循环（`free-models.astro:743-760`）现在把非 text 块画成 `[${blk.type}]`，于是思维链显示成 `[thinking]`。改成按类型分流：

- `{type:'text'}` → 助手气泡（现状）
- `{type:'thinking'}` → `chatMsg('thinking', text)`，复用 SSE 实时流同一个 `.chat-msg--thinking` 样式（已存在，含 `.is-collapsed` 折叠态）
- `{type:'image'}` → `[图片]`（现状）
- 其他未知块 → `[${blk.type}]`（现状兜底）

用户已确认选 **A：思维链与正文都显示，与 CLI 一致**。同一轮里先思维链后正文，顺序按 `content` 数组的原始次序。

## 已知风险（记录，本期不修）

**pi 跨 provider 恢复时，旧模型写进 `messages` 的块可能不被新 provider 接受**（例如某家不认 `thinking` 块）。表现是那一轮报错，历史不损坏，用户点「新对话」重开即可。

这是**既有风险的扩大，不是新引入的一类**：OpenRouter 的免费模型本来就五花八门，只去掉 `model` 也躲不开；去掉 `provider` 只是让「GLM 卡 ↔ Claude 卡」也走进这条路。cc 侧没有这个问题——`--resume` 时模型由本次请求决定，CLI 自己处理历史里的块。

不修的理由：要修就得在恢复时按 provider 过滤/改写消息块，那是「猜测哪些块哪个 provider 要」，容易把历史改坏——比让那一轮报错更糟。

## 测试

全部用**合成 fixture**，不读真实 transcript（PII 边界，沿用 2026-10-20 spec 的约束）。

**`packages/agent-server/test/transcripts.test.mjs`**
- `clear({agent,cwd}) 跨 model 清空` —— 同目录同 agent、不同 model 的三条记录，`clear({agent,cwd})` 应全删；`clear({agent,cwd,model})` 应只删匹配的那条（能力保留）
- `list({agent,cwd}) 命中跨 model / 跨 provider 的记录` —— 同目录同 agent、不同 model 的三条记录全部返回；再断言 `list({agent,cwd,model})` 仍只返回匹配的那条。**这两条一起钉住「能力保留、调用方不用」**，避免后来人误以为要把 filter 从 `list` 里删掉
- 既有那条 `list filters by agent/cwd/provider/model and sorts by lastUsed desc` **原样不动**——它测的是 store 能力，能力没变，测试就不该变。它留着本身就是「`list` 仍支持四维」的凭证

**`packages/agent-server/test/cc-adapter.test.mjs`（或既有 cc 测试文件）**
- `restore 把 jsonl 里的 user/assistant 对话读成 messages` —— 造一个假 configDir，`projects/<slug>/<id>.jsonl` 里放若干行：2 行真对话（一条 user、一条 assistant 带 thinking + text）、若干噪声行（`attachment` / `api-request-blob` / `queue-operation`）。断言返回的 messages 只有 2 条、块原样保留
- `restore 忽略带 role 的噪声行` —— `api-request-blob` 行也带 `message.role`，必须靠 `type` 排除（这条钉住「不能按 role 筛」）
- `jsonl 不存在时 restore 只回指针，不返回空数组` —— 断言 `messages` 是 `undefined` 而不是 `[]`
- `jsonl 里没有对话行时同样不回空数组`

**`packages/agent-server/test/server.test.mjs`**
- `换模型后恢复的是同一条会话` —— 端到端：同目录先用模型 A 跑一轮（走 `/messages`），再用模型 B `POST /sessions`，断言 `resumed === true` 且 `sessionId` 与第一条相同，且 `res.messages` 有内容
- 该测试复用既有的 fake-claude fixture（`FAKE_CC_MODE` 那套），不 spawn 真 CLI

**前端两处小改的验证方式**
`vitest.config.ts` 的 `include` 钉在 `src/**/*.test.*`，而现有 vitest 测的都是 `src/lib/` 下可独立导入的纯模块（`agentchat.ts` / `drawer.ts` / `prompt.ts`）；`free-models.astro` 是**页面**，它的脚本内联在 `.astro` 里、import 不进来，现有 vitest 环境（`node`，无 DOM）也跑不了它。故不新增 vitest 用例，改为：

1. **把要测的逻辑提成可导入的纯函数**，放进 `src/lib/`（如 `renderHistoryBlocks(content)` 返回块的角色序列、`sessionModelLabel(s)` 返回小标文本），再按现有套路写 vitest 用例——函数在页面里调用，测试只测函数。这是本项目已有模式（`drawer.ts` / `prompt.ts` 都这么干），不是新发明。
2. 两处 DOM 接线（思维链分支、列表行小标）由**人工验收**兜底：`astro dev` 起服务，用 cc 真跑一轮，恢复后看思维链是否折叠显示、正文是否在其后、列表行是否带模型名。

**变异测试**（照 2026-10-20 spec 的做法，每个声称都要有测试看着）：
- 把 `model`（或 `provider`）加回网关的 filter → 上面那条端到端必须红
- `restore` 改成按 `message.role` 筛 → 「忽略带 role 的噪声行」必须红
- `restore` 在 jsonl 不存在时返回 `{messages: []}` → 「不回空数组」必须红

## 落地顺序

1. 第二部分（筛选降维）——独立、可单独验证，先解决「换模型丢历史」
2. 第一部分（cc restore 读历史）——依赖 1 的测试地基（端到端那条同时覆盖两件事）
3. 前端两处小改（思维链渲染 + 模型小标）
