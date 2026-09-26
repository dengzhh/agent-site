# Pricing Data Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 成本计算器定价数据接入每日同步管道：sync 脚本新增 pricing.json 产物，页面换源并删除手工 models.json。

**Architecture:** 扩展现有 `scripts/sync-free-models.mjs`（新增纯函数 buildPricingIndex + 第二写盘），页面 `llm-api-cost-calculator.astro` 换数据源。cron/工作流/防呆全部复用，零新增 CI。

**Tech Stack:** 既有栈（Astro 7、Vitest、node 原生脚本）。

**Spec:** `docs/superpowers/specs/2026-09-27-pricing-sync-design.md`

---

### Task 1: buildPricingIndex 纯函数（TDD）

**Files:**
- Modify: `scripts/sync-free-models.mjs`
- Modify: `scripts/sync-free-models.test.mjs`

- [ ] **Step 1: 在 test.mjs 追加失败测试（describe 并列追加）**

```javascript
import { buildPricingIndex } from './sync-free-models.mjs';

describe('buildPricingIndex', () => {
  const pricingSrc = {
    anthropic: {
      id: 'anthropic', name: 'Anthropic', env: [], npm: null,
      models: {
        'claude-opus-5-5': { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', limit: { context: 1000000, output: 64000 }, cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } },
        'claude-haiku-4-5': { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', limit: { context: 200000, output: 32000 }, cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 } },
        'claude-no-cache':  { id: 'claude-no-cache', name: 'No Cache', limit: { context: 200000, output: 32000 }, cost: { input: 2, output: 8 } },
      },
    },
    openai: {
      id: 'openai', name: 'OpenAI', env: [], npm: null,
      models: {
        'gpt-image-x': { id: 'gpt-image-x', name: 'Image X', limit: { context: 128000 }, cost: { input: 5, output: 20 } },
        'tiny-embed':  { id: 'tiny-embed', name: 'Embed', limit: { context: 8191 }, cost: { input: 0.02, output: 0 } },
        'gpt-5':       { id: 'gpt-5', name: 'GPT-5', limit: { context: 400000, output: 128000 }, cost: { input: 1.25, output: 10, cache_read: 0.125 } },
      },
    },
    google: {
      id: 'google', name: 'Google', env: [], npm: null,
      models: {
        'gemini-3-flash': { id: 'gemini-3-flash', name: 'Gemini 3 Flash', limit: { context: 1048576 }, cost: { input: 0.5, output: 3, cache_read: 0.05 } },
      },
    },
  };

  it('keeps priced text models, drops images/embeds/tiny-context', () => {
    const idx = buildPricingIndex(pricingSrc);
    const openai = idx.providers.find((p) => p.id === 'openai');
    expect(openai.models.map((m) => m.id)).toEqual(['gpt-5']);
  });

  it('maps fields with null cache defaults and sorts by context desc', () => {
    const idx = buildPricingIndex(pricingSrc);
    const anthropic = idx.providers.find((p) => p.id === 'anthropic');
    expect(anthropic.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-no-cache', 'claude-haiku-4-5']);
    expect(anthropic.models[1]).toEqual({
      id: 'claude-no-cache', label: 'No Cache', context: 200000,
      input: 2, output: 8, cacheRead: null, cacheWrite: null,
    });
  });

  it('covers exactly the three mainstream providers', () => {
    const idx = buildPricingIndex(pricingSrc);
    expect(idx.providers.map((p) => p.id)).toEqual(['anthropic', 'openai', 'google']);
  });

  it('throws on zero priced models (schema collapse guard)', () => {
    expect(() => buildPricingIndex({ anthropic: { id: 'anthropic', name: 'A', models: {} } }))
      .toThrow(/no priced models/i);
  });
});
```

（import 行合并进文件顶部既有 vitest import。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run scripts/sync-free-models.test.mjs`
Expected: FAIL（buildPricingIndex 未导出）

- [ ] **Step 3: 在 sync-free-models.mjs 实现（PROVIDER_OVERRIDES 之后追加）**

```javascript
// ── Pricing index（成本计算器数据）：三家主流 provider 的有价文本模型 ──
const PRICING_PROVIDERS = ['anthropic', 'openai', 'google'];
const NON_TEXT = /image|tts|stt|embed|veo|lyria|omni|realtime|computer-use|deep-research/i;

export function buildPricingIndex(modelsdev) {
  const providers = [];
  let count = 0;
  for (const pid of PRICING_PROVIDERS) {
    const p = modelsdev[pid];
    if (!p?.models) continue;
    const models = Object.values(p.models)
      .filter((m) =>
        m.cost?.input != null && m.cost?.output != null &&
        (m.limit?.context ?? 0) >= 32000 &&
        !NON_TEXT.test(m.id ?? '') )
      .map((m) => ({
        id: m.id,
        label: m.name ?? m.id,
        context: m.limit?.context ?? 0,
        input: m.cost.input,
        output: m.cost.output,
        cacheRead: m.cost.cache_read ?? null,
        cacheWrite: m.cost.cache_write ?? null,
      }))
      .sort((a, b) => b.context - a.context);
    if (models.length === 0) continue;
    count += models.length;
    providers.push({ id: pid, name: p.name || pid, models });
  }
  if (count === 0) throw new Error('no priced models extracted — refusing to write pricing index');
  return { syncedAt: new Date().toISOString(), source: 'models.dev', providers };
}
```

- [ ] **Step 4: main() 接入第二个产物**

在 main() 的 free-models 写盘块之后追加（沿用 no-change 比较模式）：

```javascript
  const pricing = buildPricingIndex(modelsdev);
  const pricingPath = new URL('../src/data/pricing.json', import.meta.url);
  let pricingChanged = true;
  try {
    const oldPricing = JSON.parse(readFileSync(pricingPath, 'utf8'));
    const { syncedAt: _o, ...oldRest } = oldPricing;
    const { syncedAt: _n, ...newRest } = pricing;
    pricingChanged = JSON.stringify(oldRest) !== JSON.stringify(newRest);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('pricing compare failed:', err.message);
  }
  if (pricingChanged) {
    writeFileSync(pricingPath, JSON.stringify(pricing, null, 2) + '\n');
    console.log('wrote src/data/pricing.json');
  } else {
    console.log('pricing: no changes');
  }
```

（`readFileSync` 加入顶部 node:fs import。）

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run scripts/sync-free-models.test.mjs`
Expected: 7 + 4 = 11 passed；全量 `npm test` → 42 passed

- [ ] **Step 6: Commit**

```bash
git add scripts/ && git commit -m "feat: pricing index extraction in sync script"
```

---

### Task 2: 本地落盘 + 页面换源

**Files:**
- Create: `src/data/pricing.json`（脚本生成）
- Modify: `src/pages/tools/llm-api-cost-calculator.astro`
- Delete: `src/data/models.json`

- [ ] **Step 1: 跑脚本**

Run: `node scripts/sync-free-models.mjs`
Expected: stdout 含 `wrote src/data/pricing.json`；`node -e "const d=require('./src/data/pricing.json'); console.log(d.providers.map(p=>p.id+':'+p.models.length).join(' '))"`
Expected: `anthropic:~15 openai:~40 google:~19`（总数 ~74）

- [ ] **Step 2: 页面换源**

llm-api-cost-calculator.astro 修改：
- frontmatter：`import data from '../../data/pricing.json'`；模型组装改为
  ```typescript
  const ordered = data.providers.flatMap((p) =>
    p.models.map((m) => ({ ...m, provider: p.name })),
  );
  const defaultModel = ordered.find((m) => m.id === 'claude-opus-5-5') ?? ordered[0];
  ```
- select 加 optgroup：
  ```astro
  <select id="model">
    {data.providers.map((p) => (
      <optgroup label={p.name}>
        {p.models.map((m) => <option value={m.id} selected={m.id === defaultModel.id}>{m.label}</option>)}
      </optgroup>
    ))}
  </select>
  ```
- 免责行：`<p class="muted-note">Aggregated from models.dev, synced {data.syncedAt.slice(0, 10)}. Prices per 1M tokens, USD.</p>`
- 静态表与脚本 island 同步换源（脚本里 `import data from '../../data/pricing.json'`，`ModelPricing` 字段映射：`context→contextWindow`、`input→inputPerMTok`、`output→outputPerMTok`、`cacheRead→cacheReadPerMTok`——组装处 map 一次）
- 免责逻辑删除 `unverified` 相关（字段不存在了）

- [ ] **Step 3: 删除 models.json**

```bash
git rm src/data/models.json
```

- [ ] **Step 4: 全量验证**

Run: `npm run build && npm test`
Expected: 11 页、42 tests passed；`grep -c "<tr" dist/tools/llm-api-cost-calculator/index.html` ≥ 70；`grep -o '\$80.00' dist/tools/llm-api-cost-calculator/index.html` 有命中；产物无 "(unverified)"

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: cost calculator on daily-synced pricing data"
```

---

### Task 3: 合并 + 部署冒烟

- [ ] **Step 1:** feature 分支合并 main 并推送（流程同前：final 机械验证 → merge --no-ff → push）
- [ ] **Step 2:** 等待 Pages 部署成功，curl 成本计算器页 200，页面含 models.dev 免责行
- [ ] **Step 3:** 手动 `gh workflow run sync-models.yml --ref main` 触发一次，确认日志 pricing 提取正常（~74 models / no changes）

## Self-Review

- **Spec 覆盖**：§2.1 数据格式=Task1（字段 id/label/context/input/output/cacheRead/cacheWrite 一致）；§2.2 独立 no-change 判断=Task1 Step4；§3 页面=Task2（optgroup/默认 opus-5-5/免责行/静态表）；§4 清理=Task2 Step3；§5 测试=Task1+Task2 产物 grep。
- **占位符**：无。
- **类型一致**：pricing.json 字段与页面 map 映射显式列出（context→contextWindow 等）。
- **已知简化**：cacheWrite 只存不用（spec 非目标）；label 直接用 m.name（models.dev 显示名已无前缀）。
