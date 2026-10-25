# 付费热门模型榜 — Design Doc

Date: 2026-10-25
Status: Approved（方案 A：热度/价格同源 OpenRouter；可排序表格不合成打分；独立页 `/paid-models`）

## 1. 目标

免费模型页（`/free-models`）之外，新增**付费热门模型榜** `/paid-models`：把"大家都在用、值得花钱"的付费
模型按热度列出，价格、上下文、能力一并展示，并保持本站已有的一键 Configure / Chat 体验。

用户原话：「目前网站可以列出免费模型，现在也要加入付费热门模型的支持，综合热度和价格等因子列出」。

## 2. 已确认的决策

- **数据范围（方案 A）**：热度与价格都取 OpenRouter——它是唯一同时有真实用量 + 价格的机器可读数据源，
  ID 同源可精确关联。页面价格 = OpenRouter 聚合价（非官方直连价，页面注明）。
- **"综合热度和价格" = 可排序表格**（用户确认按推荐走）：默认按热度（周 token 用量）降序，价格两列展示，
  点列头切换升降序。**不合成黑盒评分**——每个数字都说得出上游来源。
- **独立页面** `/paid-models`，与 `/free-models` 对称，导航并列入口。
- **不复制聊天抽屉**：Configure/Chat 按钮是跨页链接（见 §6）。

## 3. 已探测的数据源事实（2026-10-24 实测，勿重新推导）

| 事实 | 结论 |
|---|---|
| `GET https://openrouter.ai/api/frontend/v1/rankings/models` | 公开、无需 key，200；**非官方文档化接口**（OpenRouter 网页前端在用，`/api/v1/rankings` 不存在） |
| 返回形状 | `{data: [{date, model_permaslug, variant, total_prompt_tokens, total_completion_tokens, total_native_tokens_reasoning, total_tool_calls, change, rankingMetricValue, ...}]}` |
| 窗口 | 滚动约 6 天（实测 2026-10-19 → 10-24 六个日期，652 行） |
| variant 取值 | `free` / `standard` / `batch` 三种，同一模型同一天可多行 |
| `GET https://openrouter.ai/api/v1/models` | 公开、无需 key，200（467 个模型）；有 `pricing`（$/token，字符串）、`context_length`、`canonical_slug`、`supported_parameters`、`architecture.input_modalities`、`top_provider.max_completion_tokens`、`links` |
| **无 usage 字段** | `/api/v1/models` 不携带任何用量数据（实测 `with-usage count: 0/467`）——热度必须靠上面的 frontend 接口 |
| 同族多快照 | 榜首 deepseek-v4.1-flash 有 `…-20261017` 与 `…-20260910` 两个日期后缀 id 各占一行（30.8T + 18.7T tokens/6天）——**必须按 canonical_slug 去重**，否则榜单前几名全是同一模型的新旧版 |
| 实测周榜（token 总量） | deepseek-v4.1-flash > minimax-m3.1-flash(free) > glm-5.3-flash > tencent-hy4 > claude-opus-5.5 > gpt-6-luna |

## 4. 数据管道

```
GitHub Actions sync-models.yml（现有每日任务，加一步）
  ├─ node scripts/sync-paid-models.mjs
  │    ├─ GET rankings/models（失败重试 2 次，指数退避，同 sync-free-models 模式）
  │    ├─ GET /api/v1/models（同上）
  │    ├─ buildPaidBoard(rankings, models)   ← 纯函数，vitest 覆盖
  │    └─ 写 src/data/paid-models.json（tmp + rename 原子写）
  ├─ git add 列表加上 src/data/paid-models.json
  └─ commit-if-changed（无变化不提交）→ 触发现有 Pages 部署
```

`buildPaidBoard` 步骤：

1. 只取 `variant === 'standard'` 行（`:free` 归免费页；batch 定价语义不同）
2. 按 `model_permaslug` 聚合窗口内全部日期的 prompt/completion tokens
3. 与 models API 按 id 精确关联，关联不上的跳过（stdout 记 `skipped:<n>`）
4. 按 `canonical_slug` 同族去重，保留热度最高的那个 id
5. 过滤：`pricing.prompt > 0 || pricing.completion > 0`（确保是付费模型）
6. 按热度（prompt+completion 总量）降序，取 **top 30**
7. 价格 $/token（字符串）→ $/1M（数字，保留 2 位有效数字量级）转换在脚本内完成，页面不再算

产出 `src/data/paid-models.json`：

```jsonc
{
  "syncedAt": "…",
  "source": "openrouter rankings + models api",
  "windowDays": 6,               // 实测窗口天数，页面如实展示
  "totalCandidates": 84,         // 去重后候选数（30 是截断结果，页面可说"共 N 个有用量数据的付费模型"）
  "models": [
    {
      "id": "deepseek/deepseek-v4.1-flash-20261017",
      "name": "DeepSeek v4.1 Flash",       // 取 models API 的 name
      "canonicalSlug": "deepseek-v4.1-flash",
      "heat": { "promptTokens": 1.2e13, "completionTokens": 8.9e11 },
      "price": { "input": 0.14, "output": 0.55 },   // $/1M tokens
      "context": 131072,
      "maxOutput": 32768,                     // 可空
      "toolCall": true, "reasoning": true, "attachment": false,
      "detailUrl": "https://openrouter.ai/deepseek/deepseek-v4.1-flash-20261017"
    }
  ]
}
```

能力判定（全部来自 OpenRouter models API，与方案 A 同源原则一致）：
`toolCall` = `supported_parameters` 含 `tools`；`reasoning` = 含 `reasoning`；`attachment` =
`architecture.input_modalities` 含 `image`。

## 5. 页面 `/paid-models.astro`

- 复用 BaseLayout + SyncBadge + 免费页同款表格样式；英文文案与站点一致
- 标题方向：`Trending paid LLM models`；首屏说明写明三个事实来源：热度 = OpenRouter 近
  `windowDays` 天 token 用量；价格 = OpenRouter 聚合价 $/1M；非官方直连价
- 列：`#` / Model（链到 OpenRouter 详情页）/ Weekly usage / Input $/M / Output $/M /
  Context / Capabilities / 操作
- **排序**：默认热度降序；表头（热度/输入价/输出价/上下文）可点切换升降序，`aria-sort` 标注，
  小段 vanilla JS（与免费页 cap-filter 同风格）
- 用量格式化：`1.2T` / `940B` tokens

## 6. Configure / Chat 按钮：跨页链接

聊天抽屉与配置弹窗全部内联在 free-models.astro，复制一份是坏味道。付费页按钮渲染为链接：

- `/free-models/?chat=openrouter&model=<id>&name=<name>&ctx=<context>&maxout=<maxOutput>`
- `/free-models/?configure=openrouter&model=<id>`

free-models.astro 加一个小的 URL 参数处理器：`location.search` 里有 `chat=`/`configure=` 时，
调已有的 `openChat()` / `openConfig()`（解析逻辑提成纯函数 `parseChatQuery(search)` 供单测）。

- agent 偏好：付费 openrouter 模型**不在** harness gate 范围（gate 只限 `:free`），默认 `pi`
- 免费页自身无 query 时行为不变（零回归）

## 7. 容错

- 任一 fetch 失败 → 脚本非零退出，workflow 不 commit，线上保持昨日数据
- **上游改版防护**：`buildPaidBoard` 关联率 < 50% 或结果为 0 条 → throw（宁可同步失败，不悄悄发空榜/残榜）
- 非官方接口的固有风险已由上一条兜底：改版当天 sync 红，第二天修复前数据保持旧版

## 8. 测试

- `scripts/sync-paid-models.test.mjs`（vitest，合成 fixture，不联网）：
  多日聚合、free/batch 变体排除、canonical 同族去重留最热、关联失败跳过、付费过滤、
  top-30 截断、$/token→$/1M 换算、关联率暴跌抛错、零结果抛错
- `src/lib` 下 `parseChatQuery` 纯函数单测（缺参/坏参返回 null 不炸）
- 本地 `astro dev` 人工核：排序交互、跨页链接开抽屉、`npm test`（网关 + vitest）全绿

## 9. 明确不做

- 不做综合评分公式（已确认：可排序表格代替）
- 不做官方直连价对照列（方案 B 已否）
- 不收 batch 变体、不做长尾全量（只 top 30）
- 不为榜单做独立 API key 流程（复用 openrouter key，与免费页同一套 BYOK）
- 不动免费页现有分组/筛选/表格结构（只加 query 处理器）
