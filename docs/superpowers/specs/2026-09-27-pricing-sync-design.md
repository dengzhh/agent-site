# Pricing Data Sync — Design Doc

Date: 2026-09-27
Status: Approved

## 1. 目标

成本计算器的定价数据从手工 `models.json` 切换到每日自动同步的 `models.dev` 管道，与 free-models 同一 cron、同一脚本家族。价格页从"会过时的手工数据"变为"永不过时的自动数据"。

## 2. 数据设计

### 2.1 产物 `src/data/pricing.json`（新增，同步脚本第二个产物）

```json
{
  "syncedAt": "2026-09-27T03:23:11Z",
  "source": "models.dev",
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "models": [
        {
          "id": "claude-opus-5-5",
          "label": "Claude Opus 5.5",
          "context": 1000000,
          "input": 4.0,
          "output": 20.0,
          "cacheRead": 0.2,
          "cacheWrite": 5.0
        }
      ]
    }
  ]
}
```

- label 派生：`m.name`（models.dev 自带显示名），去尾部供应商前缀
- 收录规则：providers = `anthropic/openai/google` 三家；模型 = `cost.input != null && cost.output != null && limit.context >= 32000`，排除 `/image|tts|stt|embed|veo|lyria|omni|realtime|computer-use|deep-research/i`；context 降序
- `cacheRead`/`cacheWrite` 可为 null（部分模型无缓存价），字段恒存在

### 2.2 同步脚本扩展

`scripts/sync-free-models.mjs` 内新增纯函数 `buildPricingIndex(modelsdev)` + 写盘。同一 main() 运行：两个产物独立做"无变化不写盘"判断（free-models 有变化、pricing 无变化 → 只提交前者）。防呆沿用：pricing 提取 0 条 → 抛错拒写。

## 3. 页面改造（llm-api-cost-calculator.astro）

- 数据源 `models.json` → `pricing.json`
- 静态渲染默认场景表（10k in/2k out/1000 req/0% cache）保留，行数从 11 → ~74
- 默认模型 `claude-opus-5-5`（$80 基线不变）
- 免责行改为 "Aggregated from models.dev, synced {date}."；删除 `verify`/`(unverified)` 机制（数据来源单一化后无此概念）
- 下拉按 provider 分组（optgroup），每组内 context 降序
- `select` 的 option 文案 `{provider} · {label}` 保持
- monthlyCost（cost.ts）不动；cache-read 混合公式对 `cacheRead: null` 的模型退化为全额输入价（现有 `!= null` 分支已处理）

## 4. 清理

- 删除 `src/data/models.json`（唯一消费方是成本计算器页）
- frameworks.json 不受影响

## 5. 测试

- `buildPricingIndex`：过滤规则（非文本模型/低上下文/无定价剔除）、字段映射、label 派生、空结果抛错路径——TDD，与 free-models 测试同文件风格
- 页面构建产物 grep：默认表行数 ≥70、$80.00 基线存在、免责行含 models.dev

## 6. 非目标

- cacheWrite 计费进月成本公式（现有 CostInput 无此维度，页面无输入位——数据先存着，UI 留待需要时加）
- 免费层限额模型（下一事项②单独做）
- provider 白名单扩展到三家以外（成本计算器聚焦主流三家）
