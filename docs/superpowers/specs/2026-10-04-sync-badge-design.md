# 数据更新时间标注 + 首页迷你价格表动态化

日期：2026-10-04

## 问题

1. 三个数据页面（free-models / cost calculator / framework 对比）虽有 `muted-note`
   小字标注数据时间，但视觉上不显眼，用户逛一圈注意不到。
2. 首页迷你价格表（`$80/$40/$33/$11`）硬编码在 `index.astro`，不随 pricing.json
   同步更新。已发现偏差：GPT-5 实际 $32（硬编码 $33）；Gemini 已出 3.8 版而首页
   仍引用旧的 "Gemini 3 Flash"。

## 方案

### 1. 新组件 `src/components/SyncBadge.astro`

- 胶囊徽章：内联时钟 SVG 图标 + 日期 + 同步说明；强调色（cobalt）边框浅底。
- Props：`date`（string，必填）、`detail`（string，可选）。
- 渲染：`[icon] Data updated {date} · {detail}`（detail 为空则只显示日期部分）。
- 放置于三个数据页 h1 下方、正文介绍之上。
- 三页文案：
  - free-models：`date=idx.syncedAt, detail="auto-synced daily from models.dev + OpenRouter"`
  - cost calculator：`date=data.syncedAt, detail="auto-synced daily from models.dev"`
  - frameworks：`date=data.asOf, detail="manually curated"`
- 原 muted-note 中重复的同步时间句子移除，其余补充说明保留。

### 2. 首页迷你价格表动态化（`src/pages/index.astro`）

- frontmatter 导入 `pricing.json` 与 `src/lib/cost.ts` 的 `monthlyCost`。
- 固定展示 id 列表：`claude-opus-5-5` / `claude-sonnet-5` / `gpt-5` /
  `gemini-3-flash-preview`；按 id 查数据，缺失的自动跳过该行（上游改名/下架不崩页）。
- 用量与现硬编码一致：10k in / 2k out × 1000 req，`Math.round` 取整，`$` 前缀。
- label 优先取 pricing.json 的 `label`（跟随上游改名）。
- `mini-foot` 追加 `· pricing synced {syncedAt.slice(0,10)}`。

### 3. 不做的事

- 不改同步脚本 / workflows / BaseLayout 页脚。
- frameworks.json 手动 `asOf` 机制保持不变。

## 验证

- `npm test`：现有测试无回归（本次无新纯函数，不新增测试）。
- dev server 热更新后浏览器截图四页（首页 + 三个数据页）人工核对：
  徽章渲染、首页数字（GPT-5 应显示 $32）、Gemini 行 label 来自数据。
