# Free Models Aggregator — Design Doc

Date: 2026-09-26
Status: Approved (方案 A + OpenRouter 官方 API 交叉校验)

## 1. 目标

为 agent-site 新增全站流量入口级工具：**免费模型聚合页 + 一键配置生成器**。用户发现可白嫖的免费 LLM（价格=0），并一键生成接入 Claude Code 等工具的配置片段。

Phase 2 首个功能。本期不含：成本计算器接自动同步管道（留下期）、免费层限额类模型（RPM 限流非零价，语义不同，留下期）。

## 2. 已确认的决策

- **数据策略**：构建时自动同步（GitHub Actions 每日定时），站点保持纯静态零成本
- **数据源**：models.dev `api.json`（主源）+ OpenRouter 官方 `/api/v1/models`（对 OpenRouter 条目交叉校验）
- **"免费"定义**：input 与 output 定价均为 0（硬免费）；免费层限额模型不收
- **范围**：汇总页 + 配置生成器
- **API key 安全**：只在用户浏览器本地拼接进生成内容，永不上传（站点无后端）

## 3. 数据管道

```
GitHub Actions (cron 每日 UTC 03:23，避开整点)
  ├─ node scripts/sync-free-models.mjs
  │    ├─ GET https://models.dev/api.json（重试 2 次，指数退避）
  │    ├─ GET https://openrouter.ai/api/v1/models（交叉源，失败仅警告）
  │    ├─ 过滤：cost.input===0 && cost.output===0
  │    ├─ 交叉校验：OpenRouter 条目若官方 API 已无此 :free id → 丢弃并 console.warn
  │    ├─ provider 白名单过滤（见 §4）+ 每模型字段裁剪
  │    └─ 写 src/data/free-models.json（含 syncedAt、source、counts）
  ├─ git diff --quiet src/data/free-models.json || (git commit + push)
  └─ push 触发现有 Pages 部署工作流
```

- 无变化不产生空提交
- 任一源拉取失败：models.dev 失败则整个任务失败（保留昨日数据不上线坏数据）；OpenRouter 失败仅降级为不校验
- 手动触发：workflow_dispatch

## 4. Provider 白名单

首期收录 12 家（可注册、对外服务、非镜像聚合站的"源头"）：

`openrouter, nvidia, groq, mistral, cerebras, zai, github-copilot, cloudflare-workers-ai, alibaba-token-plan, deepinfra, together, fireworks`

白名单维护在同步脚本顶部数组。models.dev 里其余 35 家免费 provider 多为聚合网关/镜像/企业内部，不收（避免为用户生成注册不到的配置）。

## 5. 生成数据格式 `src/data/free-models.json`

```json
{
  "syncedAt": "2026-09-26T03:23:11Z",
  "source": "models.dev + openrouter/api/v1/models",
  "totalFree": 137,
  "providers": [
    {
      "id": "openrouter",
      "name": "OpenRouter",
      "api": "https://openrouter.ai/api/v1",
      "envKey": "OPENROUTER_API_KEY",
      "npm": "@openrouter/ai-sdk-provider",
      "doc": "https://openrouter.ai/docs",
      "note": "Free models are rate-limited (≈20 req/min with $10 credit, 50/day without).",
      "models": [
        {
          "id": "google/gemma-4-31b-it:free",
          "name": "Gemma 4 31B (free)",
          "context": 262144,
          "maxOutput": 32768,
          "toolCall": true,
          "reasoning": true,
          "attachment": true,
          "openWeights": true,
          "lastUpdated": "2026-04-02"
        }
      ]
    }
  ]
}
```

## 6. 页面设计

### 6.1 汇总页 `/free-models/`

- 静态渲染全部免费模型表（SEO 主体内容）：provider 分节，每模型列 name / context / max output / 能力图标（tool·reason·vision·open-weights）/ 更新日期
- 页首：syncedAt + 模型总数 + 数据来源与"免费定义"说明（诚实披露，含 OpenRouter 免费档限流提示）
- 排序默认按 context 降序；每行"Configure →"进入生成器锚点
- 首页 hero 下方加入口卡（COMPARE 旁加 FREE 标签卡），主导航加 "Free Models"

### 6.2 配置生成器（同页下半部 `/free-models/#configure`）

流程：选 provider → 选模型 → （可选）粘贴 API key → 选目标工具 → 生成 + 复制。

- **目标工具首期 4 个**：
  1. **Claude Code**：`~/.claude/settings.json` 的 `env` 块（`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`）——仅对 OpenAI 兼容 provider 有效；Anthropic 原生协议 provider（如 zai 的 anthropic 兼容端点）用对应字段
  2. **Codex CLI**：`~/.codex/config.toml` 片段（model_provider 定义 + env）
  3. **环境变量**：`export` 命令（shell 通用）
  4. **AI SDK**：该 provider 的 npm 包 + `createOpenRouter(...)` 示例代码（用数据里的 `npm` 字段）
- API key 输入框：`type="password"`、标注"只在你的浏览器里拼接，不会发送到任何服务器"、blur 提示
- 生成逻辑纯客户端（`src/lib/freeconfig.ts`，可单测）；输出 `<pre>` textContent + Copy 按钮（沿用现有模板规范：aria-live、form submit、esc 转义）
- Claude Code 条目附文档链接（code.claude.com 模型配置页）

## 7. 架构与文件

```
scripts/sync-free-models.mjs        # 数据同步脚本（node，无依赖，fetch 原生）
.github/workflows/sync-models.yml   # 每日 cron + workflow_dispatch
src/data/free-models.json           # 生成物，进仓库（构建消费）
src/lib/freeconfig.test.ts          # 配置生成逻辑单测（TDD）
src/lib/freeconfig.ts               # 4 种目标工具的片段生成
src/pages/free-models.astro         # 汇总页 + 生成器（同页两 section）
```

- 同步脚本无第三方依赖（node 22 原生 fetch），CI 不用装包
- 生成器 UI 遵循 Phase 1 沉淀的工具页模板规范

## 8. 错误处理

| 场景 | 行为 |
|---|---|
| models.dev 拉取失败 | 重试 2 次（1s/4s 退避）后退出非零，Actions 失败，站点保留上次数据 |
| OpenRouter API 失败 | console.warn，跳过交叉校验（不阻断） |
| 同步结果为空（0 免费模型） | 视为异常，退出非零（防止上游 schema 变化导致全量清空上线） |
| 上游 schema 变化 | 字段缺失的条目跳过并计数 warn；>50% 条目被跳过则失败 |

## 9. 测试

- `freeconfig.ts`：TDD，覆盖 4 种目标 ×（OpenAI 兼容 / Anthropic 兼容）× key 有无，快照断言生成片段的精确文本
- 同步脚本：核心过滤/裁剪函数抽为纯函数 `buildFreeModelsIndex(raw)`，单测覆盖（空数据、白名单外、非零价、OpenRouter 校验丢弃）
- 页面：构建产物 grep（syncedAt 渲染、静态表行数、生成器锚点）

## 10. 成功指标

- 每日同步自动跑通，free-models.json 按需更新，无人工介入
- 汇总页收录 ≥100 个免费模型、≥8 家 provider
- 生成器可在浏览器内完整走通：选 OpenRouter gemma free → 生成 Claude Code settings 片段 → 复制

## 11. 非目标（本期不做）

- 成本计算器接入同步管道（下期）
- 免费层限额模型（Gemini Flash 等 RPM 类）
- 一键写本地文件（浏览器安全模型不允许；以复制粘贴片段为最终形态）
- 用户自定义 provider / 收藏
