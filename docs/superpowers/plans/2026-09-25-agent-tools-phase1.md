# Agent Tools Site — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 上线一个纯前端 AI Agent 工具站（4 个交互工具 + 框架对比页 + 合规页），部署到 Cloudflare Pages，可被 Google 收录。

**Architecture:** Astro 静态站（SSG）。所有交互工具用 Astro `<script>` 原生 JS 岛屿实现，可测试的纯逻辑抽到 `src/lib/*.ts`（Vitest 单测），定价/框架数据放 `src/data/*.json` 构建时注入。无后端、无数据库。

**Tech Stack:** Astro 5、TypeScript、Vitest、Cloudflare Pages、@astrojs/sitemap。

**Spec:** `docs/superpowers/specs/2026-09-25-agent-tools-site-design.md`（Phase 1 范围）

---

## 文件结构

```
agent-site/
├── package.json / astro.config.mjs / tsconfig.json / vitest.config.ts
├── public/
│   ├── robots.txt
│   └── favicon.svg
├── src/
│   ├── data/
│   │   ├── models.json        # LLM 定价数据（Claude/GPT/Gemini）
│   │   └── frameworks.json    # Agent 框架对比数据
│   ├── lib/                   # 纯逻辑，全部有单测
│   │   ├── cost.ts            # API 成本计算
│   │   ├── tokens.ts          # token 估算
│   │   ├── prompt.ts          # system prompt 组装
│   │   └── mcp.ts             # MCP 配置生成
│   ├── layouts/BaseLayout.astro   # 全站骨架 + 全局 CSS + SEO meta
│   ├── styles/global.css
│   └── pages/
│       ├── index.astro                    # 首页：工具导航
│       ├── tools/
│       │   ├── llm-api-cost-calculator.astro
│       │   ├── token-estimator.astro
│       │   ├── system-prompt-generator.astro
│       │   └── mcp-config-generator.astro
│       ├── compare/agent-frameworks.astro
│       ├── about.astro / privacy.astro / contact.astro
│       └── 404.astro
```

每个 lib 模块一个职责；每个工具页自包含（markup + script）；数据 JSON 与逻辑分离，更新定价只改 JSON。

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `astro.config.mjs`, `tsconfig.json`, `src/pages/index.astro`

- [ ] **Step 1: 初始化 Astro 项目**

```bash
cd /home/dengzh/AI/agent-site
npm create astro@latest -- --template minimal --no-install --no-git --yes ./
npm install astro @astrojs/sitemap
npm install -D vitest typescript
```

- [ ] **Step 2: 配置 astro.config.mjs**

```javascript
// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://agenttools.example.com', // Task 12 买了域名后替换为真实域名
  integrations: [sitemap()],
});
```

- [ ] **Step 3: 配置 package.json scripts（加 test）**

```json
{
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "test": "vitest run"
  }
}
```

- [ ] **Step 4: 创建 vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
```

- [ ] **Step 5: 验证构建**

Run: `npm run build`
Expected: `dist/index.html` 生成，退出码 0

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold astro project with vitest and sitemap"
```

---

### Task 2: 定价数据文件

**Files:**
- Create: `src/data/models.json`

- [ ] **Step 1: 写入数据**

Claude 定价来自 Anthropic 官方缓存表（2026-06-24）；GPT/Gemini 为执行时需核对的行情价（`asOf` 字段标注，UI 会展示）。

```json
{
  "asOf": "2026-09-25",
  "note": "Prices per 1M tokens, USD. Verify non-Anthropic prices before relying on them.",
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "models": [
        { "id": "claude-fable-5-1", "label": "Claude Fable 5.1", "contextWindow": 1000000, "inputPerMTok": 10.0, "outputPerMTok": 50.0, "cacheReadPerMTok": 0.25 },
        { "id": "claude-opus-5-5", "label": "Claude Opus 5.5", "contextWindow": 1000000, "inputPerMTok": 4.0, "outputPerMTok": 20.0, "cacheReadPerMTok": 0.20 },
        { "id": "claude-opus-5", "label": "Claude Opus 5", "contextWindow": 1000000, "inputPerMTok": 5.0, "outputPerMTok": 25.0, "cacheReadPerMTok": 0.50 },
        { "id": "claude-sonnet-5", "label": "Claude Sonnet 5", "contextWindow": 1000000, "inputPerMTok": 2.0, "outputPerMTok": 10.0, "cacheReadPerMTok": 0.20 },
        { "id": "claude-haiku-4-5", "label": "Claude Haiku 4.5", "contextWindow": 200000, "inputPerMTok": 1.0, "outputPerMTok": 5.0, "cacheReadPerMTok": 0.10 },
        { "id": "claude-opus-4-8", "label": "Claude Opus 4.8", "contextWindow": 1000000, "inputPerMTok": 5.0, "outputPerMTok": 25.0, "cacheReadPerMTok": 0.50 }
      ]
    },
    {
      "id": "openai",
      "name": "OpenAI",
      "verify": true,
      "models": [
        { "id": "gpt-5", "label": "GPT-5", "contextWindow": 400000, "inputPerMTok": 1.25, "outputPerMTok": 10.0, "cacheReadPerMTok": 0.125 },
        { "id": "gpt-5-mini", "label": "GPT-5 mini", "contextWindow": 400000, "inputPerMTok": 0.25, "outputPerMTok": 2.0, "cacheReadPerMTok": 0.025 },
        { "id": "gpt-5-nano", "label": "GPT-5 nano", "contextWindow": 400000, "inputPerMTok": 0.05, "outputPerMTok": 0.40, "cacheReadPerMTok": 0.005 }
      ]
    },
    {
      "id": "google",
      "name": "Google",
      "verify": true,
      "models": [
        { "id": "gemini-3-pro", "label": "Gemini 3 Pro", "contextWindow": 1000000, "inputPerMTok": 2.0, "outputPerMTok": 12.0, "cacheReadPerMTok": 0.20 },
        { "id": "gemini-3-flash", "label": "Gemini 3 Flash", "contextWindow": 1000000, "inputPerMTok": 0.50, "outputPerMTok": 3.0, "cacheReadPerMTok": 0.05 }
      ]
    }
  ]
}
```

- [ ] **Step 2: 校验 JSON 合法**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/data/models.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add src/data/models.json && git commit -m "feat: add llm pricing data"
```

---

### Task 3: 成本计算逻辑（TDD）

**Files:**
- Create: `src/lib/cost.ts`
- Test: `src/lib/cost.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { monthlyCost, type ModelPricing } from './cost';

const opus55: ModelPricing = {
  id: 'claude-opus-5-5', label: 'Opus 5.5', contextWindow: 1_000_000,
  inputPerMTok: 4.0, outputPerMTok: 20.0, cacheReadPerMTok: 0.20,
};
const haiku: ModelPricing = {
  id: 'claude-haiku-4-5', label: 'Haiku 4.5', contextWindow: 200_000,
  inputPerMTok: 1.0, outputPerMTok: 5.0,
};

describe('monthlyCost', () => {
  it('10k in / 2k out × 1000 req on opus-5-5 = $80', () => {
    expect(monthlyCost(opus55, { inputTokens: 10_000, outputTokens: 2_000, requestsPerMonth: 1000 }))
      .toBeCloseTo(80, 6);
  });
  it('zero requests = $0', () => {
    expect(monthlyCost(haiku, { inputTokens: 5000, outputTokens: 1000, requestsPerMonth: 0 })).toBe(0);
  });
  it('cache read discount applies to input only', () => {
    // 90% cache read: input = 4*(0.1) + 0.2*(0.9) = 0.58/M
    const r = monthlyCost(opus55, { inputTokens: 1_000_000, outputTokens: 0, requestsPerMonth: 1, cacheReadPct: 0.9 });
    expect(r).toBeCloseTo(0.58, 6);
  });
  it('model without cacheRead uses full input price', () => {
    const r = monthlyCost(haiku, { inputTokens: 1_000_000, outputTokens: 0, requestsPerMonth: 1, cacheReadPct: 0.9 });
    expect(r).toBeCloseTo(1.0, 6);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/cost.test.ts`
Expected: FAIL（`Cannot find module './cost'`）

- [ ] **Step 3: 最小实现**

```typescript
export interface ModelPricing {
  id: string;
  label: string;
  contextWindow: number;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
}

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  requestsPerMonth: number;
  cacheReadPct?: number; // 0–1
}

export function monthlyCost(m: ModelPricing, i: CostInput): number {
  const cachePct = Math.min(Math.max(i.cacheReadPct ?? 0, 0), 1);
  const effInput = m.cacheReadPerMTok != null
    ? m.inputPerMTok * (1 - cachePct) + m.cacheReadPerMTok * cachePct
    : m.inputPerMTok;
  const perRequest = (i.inputTokens / 1e6) * effInput + (i.outputTokens / 1e6) * m.outputPerMTok;
  return perRequest * i.requestsPerMonth;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/cost.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/lib/cost.ts src/lib/cost.test.ts && git commit -m "feat: monthly cost calculation with cache discount"
```

---

### Task 4: 全局布局与样式 + 首页

**Files:**
- Create: `src/layouts/BaseLayout.astro`, `src/styles/global.css`
- Modify: `src/pages/index.astro`（覆盖模板内容）

- [ ] **Step 1: BaseLayout.astro**

```astro
---
interface Props { title: string; description: string; }
const { title, description } = Astro.props;
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <meta name="description" content={description} />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="canonical" href={new URL(Astro.url.pathname, Astro.site)} />
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/">AgentToolbox</a>
      <nav>
        <a href="/tools/llm-api-cost-calculator/">Cost Calculator</a>
        <a href="/tools/token-estimator/">Token Estimator</a>
        <a href="/tools/system-prompt-generator/">Prompt Generator</a>
        <a href="/tools/mcp-config-generator/">MCP Config</a>
        <a href="/compare/agent-frameworks/">Frameworks</a>
      </nav>
    </header>
    <main class="container"><slot /></main>
    <footer class="site-footer">
      <p>© {new Date().getFullYear()} AgentToolbox · <a href="/about/">About</a> · <a href="/privacy/">Privacy</a> · <a href="/contact/">Contact</a></p>
    </footer>
  </body>
</html>
```

- [ ] **Step 2: global.css（深浅色自适应，系统字体栈）**

```css
:root {
  --bg: #ffffff; --fg: #1a1a2e; --muted: #6b7280;
  --card: #f6f7f9; --accent: #4f46e5; --border: #e5e7eb;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1117; --fg: #e5e7eb; --muted: #9ca3af; --card: #1a1d27; --accent: #818cf8; --border: #2a2e3a; }
}
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6; }
.container { max-width: 860px; margin: 0 auto; padding: 1.5rem; }
.site-header { display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); flex-wrap: wrap; gap: .5rem; }
.brand { font-weight: 700; font-size: 1.15rem; color: var(--accent); text-decoration: none; }
.site-header nav { display: flex; gap: 1rem; flex-wrap: wrap; }
.site-header nav a { color: var(--muted); text-decoration: none; font-size: .9rem; }
.site-header nav a:hover { color: var(--accent); }
.site-footer { border-top: 1px solid var(--border); padding: 1rem 1.5rem; color: var(--muted); font-size: .85rem; }
.tool-card { display: block; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem; text-decoration: none; color: inherit; }
.tool-card:hover { border-color: var(--accent); }
.tool-card h2 { margin: 0 0 .25rem; font-size: 1.05rem; }
.tool-card p { margin: 0; color: var(--muted); font-size: .9rem; }
label { display: block; font-size: .85rem; margin-bottom: .25rem; color: var(--muted); }
input, select, textarea {
  width: 100%; padding: .5rem .65rem; margin-bottom: 1rem;
  background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; font: inherit;
}
button { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: .55rem 1.2rem; font: inherit; cursor: pointer; }
pre { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; overflow-x: auto; font-size: .85rem; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { border: 1px solid var(--border); padding: .5rem .65rem; text-align: left; }
.result { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-top: 1rem; }
```

在 BaseLayout 的 `</body>` 前 `<style is:global>@import '../styles/global.css';</style>` 不生效——直接在 head 里加：

```astro
<style is:global>@import '../styles/global.css';</style>
```

（放在 `<link rel="canonical">` 之后。）

- [ ] **Step 3: 首页 index.astro**

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
const tools = [
  { href: '/tools/llm-api-cost-calculator/', name: 'LLM API Cost Calculator', desc: 'Compare monthly API costs across Claude, GPT, and Gemini models.' },
  { href: '/tools/token-estimator/', name: 'Token Estimator', desc: 'Estimate how many tokens your prompt uses per model family.' },
  { href: '/tools/system-prompt-generator/', name: 'System Prompt Generator', desc: 'Build a structured system prompt for your AI agent.' },
  { href: '/tools/mcp-config-generator/', name: 'MCP Config Generator', desc: 'Generate MCP server configs for Claude Code, Cursor, and VS Code.' },
  { href: '/compare/agent-frameworks/', name: 'Agent Framework Comparison', desc: 'LangGraph vs CrewAI vs OpenAI Agents SDK vs Claude Agent SDK.' },
];
---
<BaseLayout title="AgentToolbox — Free AI Agent Tools" description="Free online tools for AI agent developers: API cost calculators, token estimators, prompt generators, and MCP config builders.">
  <h1>Free Tools for AI Agent Builders</h1>
  <p>Everything you need to plan, build, and cost out your next AI agent — no signup, runs entirely in your browser.</p>
  <div style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));margin-top:1.5rem;">
    {tools.map((t) => (
      <a class="tool-card" href={t.href}><h2>{t.name}</h2><p>{t.desc}</p></a>
    ))}
  </div>
</BaseLayout>
```

- [ ] **Step 4: 创建 public/favicon.svg 与 public/robots.txt**

favicon.svg：

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#4f46e5"/><text x="50" y="68" font-size="52" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="bold">A</text></svg>
```

robots.txt：

```
User-agent: *
Allow: /

Sitemap: https://agenttools.example.com/sitemap-index.xml
```

（Task 12 替换真实域名。）

- [ ] **Step 5: 验证**

Run: `npm run build && npm run preview &`，curl `http://localhost:4321/`
Expected: HTML 含 "Free Tools for AI Agent Builders"

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: base layout, global styles, homepage"
```

---

### Task 5: LLM API 成本计算器页面

**Files:**
- Create: `src/pages/tools/llm-api-cost-calculator.astro`

- [ ] **Step 1: 页面 markup + script**

```astro
---
import BaseLayout from '../../layouts/BaseLayout.astro';
import data from '../../data/models.json';
const models = data.providers.flatMap((p) => p.models.map((m) => ({ ...m, provider: p.name })));
---
<BaseLayout
  title="LLM API Cost Calculator — Claude vs GPT vs Gemini Pricing"
  description="Calculate and compare monthly API costs for Claude, GPT, and Gemini models. Includes prompt caching discounts."
>
  <h1>LLM API Cost Calculator</h1>
  <p>Estimate your monthly spend per model, then compare all models side by side. Pricing as of {data.asOf}.</p>

  <div class="field-row">
    <div><label for="model">Model</label>
      <select id="model">{models.map((m) => <option value={m.id}>{m.provider} · {m.label}</option>)}</select>
    </div>
    <div><label for="reqs">Requests / month</label><input id="reqs" type="number" value="1000" min="0" /></div>
  </div>
  <div class="field-row">
    <div><label for="in">Input tokens / request</label><input id="in" type="number" value="10000" min="0" /></div>
    <div><label for="out">Output tokens / request</label><input id="out" type="number" value="2000" min="0" /></div>
  </div>
  <div><label for="cache">Cache read % of input (0–100)</label><input id="cache" type="number" value="0" min="0" max="100" /></div>
  <button id="calc">Calculate</button>

  <div class="result" id="single" hidden></div>
  <h2 style="margin-top:2rem">All models comparison</h2>
  <div class="result" id="table"></div>
</BaseLayout>

<style>
  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  @media (max-width: 600px) { .field-row { grid-template-columns: 1fr; } }
</style>

<script>
  import { monthlyCost, type ModelPricing } from '../../lib/cost';
  import data from '../../data/models.json';

  const models: (ModelPricing & { provider: string })[] = data.providers.flatMap((p) =>
    p.models.map((m) => ({ ...m, provider: p.name })),
  );
  const $ = (id: string) => document.getElementById(id)!;

  function inputs() {
    return {
      inputTokens: Number(($('in') as HTMLInputElement).value) || 0,
      outputTokens: Number(($('out') as HTMLInputElement).value) || 0,
      requestsPerMonth: Number(($('reqs') as HTMLInputElement).value) || 0,
      cacheReadPct: (Number(($('cache') as HTMLInputElement).value) || 0) / 100,
    };
  }

  function render() {
    const i = inputs();
    const id = ($('model') as HTMLSelectElement).value;
    const m = models.find((x) => x.id === id)!;
    const cost = monthlyCost(m, i);
    ($('single') as HTMLElement).hidden = false;
    $('single').innerHTML = `<strong>${m.provider} ${m.label}</strong>: <code>$${cost.toFixed(2)}</code>/month`;

    const rows = models
      .map((x) => ({ x, c: monthlyCost(x, i) }))
      .sort((a, b) => a.c - b.c)
      .map(({ x, c }) => `<tr><td>${x.provider}</td><td>${x.label}</td><td>$${c.toFixed(2)}</td></tr>`)
      .join('');
    $('table').innerHTML = `<table><thead><tr><th>Provider</th><th>Model</th><th>Monthly cost</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  $('calc').addEventListener('click', render);
  render();
</script>
```

- [ ] **Step 2: 手动验证**

Run: `npm run dev`，浏览器打开 `http://localhost:4321/tools/llm-api-cost-calculator/`
Expected: 默认 Opus 5.5 / 10k in / 2k out / 1000 req 显示 $80.00；排序表最便宜为 GPT-5 nano

- [ ] **Step 3: 构建通过 + Commit**

Run: `npm run build`
Expected: 成功，无 TS 错误

```bash
git add src/pages/tools/llm-api-cost-calculator.astro && git commit -m "feat: llm api cost calculator page"
```

---

### Task 6: Token 估算逻辑（TDD）

**Files:**
- Create: `src/lib/tokens.ts`
- Test: `src/lib/tokens.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { estimateTokens } from './tokens';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('', 'claude')).toBe(0);
  });
  it('scales with length', () => {
    const short = estimateTokens('hello world', 'claude');
    const long = estimateTokens('hello world '.repeat(100), 'claude');
    expect(long).toBeGreaterThan(short * 80);
  });
  it('handles pure CJK (roughly 1 token per char)', () => {
    const t = estimateTokens('你好世界测试', 'claude');
    expect(t).toBeGreaterThanOrEqual(6);
    expect(t).toBeLessThanOrEqual(8);
  });
  it('handles mixed text without crashing', () => {
    expect(estimateTokens('Hello 你好 code ```python\nprint(1)\n```', 'gpt')).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/tokens.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现（客户端近似：CJK 字符计 1 token/字，其余按字符数/系数）**

```typescript
export type ModelFamily = 'claude' | 'gpt' | 'gemini';

const CHARS_PER_TOKEN: Record<ModelFamily, number> = {
  claude: 3.6,
  gpt: 4.0,
  gemini: 4.0,
};

export function estimateTokens(text: string, family: ModelFamily): number {
  if (!text) return 0;
  const cjk = (text.match(/[一-鿿぀-ヿ가-힯]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.max(1, Math.ceil(cjk + other / CHARS_PER_TOKEN[family]));
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/tokens.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/lib/tokens.ts src/lib/tokens.test.ts && git commit -m "feat: heuristic token estimator"
```

---

### Task 7: Token 估算器页面

**Files:**
- Create: `src/pages/tools/token-estimator.astro`

- [ ] **Step 1: 页面**

```astro
---
import BaseLayout from '../../layouts/BaseLayout.astro';
---
<BaseLayout
  title="Token Estimator — Count Tokens for Claude, GPT & Gemini"
  description="Paste your prompt to estimate token counts across Claude, GPT, and Gemini tokenizers. Client-side approximation, nothing leaves your browser."
>
  <h1>Token Estimator</h1>
  <p>Paste any text. Estimates update live for each model family. This is a heuristic estimate (±10–20%); use your provider's count API for exact billing numbers.</p>
  <label for="text">Your prompt</label>
  <textarea id="text" rows="10" placeholder="Paste your prompt here..."></textarea>
  <div class="result" id="out" hidden></div>
</BaseLayout>

<script>
  import { estimateTokens } from '../../lib/tokens';
  const ta = document.getElementById('text') as HTMLTextAreaElement;
  const out = document.getElementById('out') as HTMLElement;
  function render() {
    const text = ta.value;
    if (!text.trim()) { out.hidden = true; return; }
    out.hidden = false;
    const rows = (['claude', 'gpt', 'gemini'] as const).map((f) =>
      `<tr><td>${f.toUpperCase()}</td><td>${estimateTokens(text, f).toLocaleString()}</td></tr>`).join('');
    out.innerHTML = `<table><thead><tr><th>Family</th><th>≈ Tokens</th></tr></thead><tbody>${rows}</tbody></table>
      <p style="color:var(--muted);font-size:.85rem">Characters: ${text.length.toLocaleString()} · Words: ${text.trim().split(/\s+/).length.toLocaleString()}</p>`;
  }
  ta.addEventListener('input', render);
</script>
```

- [ ] **Step 2: 手动验证**

Run: `npm run dev` 打开 `/tools/token-estimator/`，粘贴一段英文
Expected: 三行估算值随输入实时变化；清空后结果区隐藏

- [ ] **Step 3: Commit**

```bash
git add src/pages/tools/token-estimator.astro && git commit -m "feat: token estimator page"
```

---

### Task 8: System Prompt 生成逻辑（TDD）

**Files:**
- Create: `src/lib/prompt.ts`
- Test: `src/lib/prompt.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { generateSystemPrompt } from './prompt';

describe('generateSystemPrompt', () => {
  it('assembles all filled sections', () => {
    const p = generateSystemPrompt({
      role: 'code reviewer', task: 'review pull requests', tone: 'concise',
      constraints: 'Never approve untested code', outputFormat: 'bullet list',
    });
    expect(p).toContain('# Role');
    expect(p).toContain('code reviewer');
    expect(p).toContain('review pull requests');
    expect(p).toContain('concise');
    expect(p).toContain('Never approve untested code');
    expect(p).toContain('bullet list');
  });
  it('omits empty optional sections', () => {
    const p = generateSystemPrompt({ role: 'assistant', task: 'answer questions' });
    expect(p).toContain('# Role');
    expect(p).not.toContain('Constraints');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/prompt.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
export interface PromptFields {
  role: string;
  task: string;
  tone?: string;
  constraints?: string;
  outputFormat?: string;
}

export function generateSystemPrompt(f: PromptFields): string {
  const sections: string[] = [
    `# Role\nYou are ${f.role}.`,
    `# Task\n${f.task}`,
  ];
  if (f.tone?.trim()) sections.push(`# Tone\n${f.tone.trim()}`);
  if (f.constraints?.trim()) sections.push(`# Constraints\n- ${f.constraints.trim().split('\n').join('\n- ')}`);
  if (f.outputFormat?.trim()) sections.push(`# Output Format\n${f.outputFormat.trim()}`);
  return sections.join('\n\n');
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/prompt.test.ts`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompt.ts src/lib/prompt.test.ts && git commit -m "feat: system prompt assembler"
```

---

### Task 9: System Prompt 生成器页面

**Files:**
- Create: `src/pages/tools/system-prompt-generator.astro`

- [ ] **Step 1: 页面**

```astro
---
import BaseLayout from '../../layouts/BaseLayout.astro';
---
<BaseLayout
  title="System Prompt Generator for AI Agents"
  description="Generate a structured system prompt for your AI agent. Fill in role, task, tone, constraints, and output format — copy the result in one click."
>
  <h1>System Prompt Generator</h1>
  <label for="role">Agent role *</label>
  <input id="role" placeholder="a senior code reviewer" />
  <label for="task">Core task *</label>
  <textarea id="task" rows="3" placeholder="Review pull requests and suggest improvements"></textarea>
  <label for="tone">Tone</label>
  <input id="tone" placeholder="concise and direct" />
  <label for="constraints">Constraints (one per line)</label>
  <textarea id="constraints" rows="3" placeholder="Never approve code without tests&#10;Ask before making file changes"></textarea>
  <label for="format">Output format</label>
  <input id="format" placeholder="A bullet list of findings ordered by severity" />
  <button id="gen">Generate Prompt</button>
  <button id="copy" hidden>Copy</button>
  <pre id="out" class="result" style="white-space:pre-wrap" hidden></pre>
</BaseLayout>

<script>
  import { generateSystemPrompt } from '../../lib/prompt';
  const $ = (id: string) => document.getElementById(id)! as HTMLInputElement;
  const out = $('out'), copy = $('copy');
  function render() {
    const role = $('role').value.trim(), task = $('task').value.trim();
    if (!role || !task) { out.hidden = true; copy.hidden = true; return; }
    out.textContent = generateSystemPrompt({
      role, task,
      tone: $('tone').value,
      constraints: $('constraints').value,
      outputFormat: $('format').value,
    });
    out.hidden = false; copy.hidden = false;
  }
  $('gen').addEventListener('click', render);
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(out.textContent ?? '');
    copy.textContent = 'Copied!';
    setTimeout(() => (copy.textContent = 'Copy'), 1500);
  });
</script>
```

- [ ] **Step 2: 手动验证**

Run: `npm run dev` 打开 `/tools/system-prompt-generator/`
Expected: 填 role+task 点 Generate 输出 Markdown 结构；点 Copy 出现 "Copied!"；role 为空时不输出

- [ ] **Step 3: Commit**

```bash
git add src/pages/tools/system-prompt-generator.astro && git commit -m "feat: system prompt generator page"
```

---

### Task 10: MCP 配置生成逻辑 + 页面（TDD + UI）

**Files:**
- Create: `src/lib/mcp.ts`, `src/lib/mcp.test.ts`, `src/pages/tools/mcp-config-generator.astro`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { generateMcpConfig, type McpServer } from './mcp';

const servers: McpServer[] = [
  { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'xxx' } },
  { name: 'docs', url: 'https://docs.example.com/mcp' },
];

describe('generateMcpConfig', () => {
  it('claude-code uses mcpServers with stdio fields', () => {
    const cfg = JSON.parse(generateMcpConfig('claude-code', servers));
    expect(cfg.mcpServers.github.command).toBe('npx');
    expect(cfg.mcpServers.github.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
    expect(cfg.mcpServers.github.env.GITHUB_TOKEN).toBe('xxx');
    expect(cfg.mcpServers.docs.url).toBe('https://docs.example.com/mcp');
  });
  it('cursor uses mcpServers too', () => {
    const cfg = JSON.parse(generateMcpConfig('cursor', servers));
    expect(cfg.mcpServers.docs.url).toBeDefined();
  });
  it('vscode uses servers with type field', () => {
    const cfg = JSON.parse(generateMcpConfig('vscode', servers));
    expect(cfg.servers.github.type).toBe('stdio');
    expect(cfg.servers.docs.type).toBe('http');
  });
  it('empty list produces empty config', () => {
    const cfg = JSON.parse(generateMcpConfig('claude-code', []));
    expect(cfg.mcpServers).toEqual({});
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/mcp.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
export type McpTarget = 'claude-code' | 'cursor' | 'vscode';

export interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export function generateMcpConfig(target: McpTarget, servers: McpServer[]): string {
  const stdio = (s: McpServer) => ({
    ...(s.command ? { command: s.command } : {}),
    ...(s.args ? { args: s.args } : {}),
    ...(s.env ? { env: s.env } : {}),
  });
  const http = (s: McpServer) => (s.url ? { url: s.url } : stdio(s));

  let obj: Record<string, unknown>;
  if (target === 'vscode') {
    obj = { servers: Object.fromEntries(servers.map((s) => [s.name, s.url ? { type: 'http', url: s.url } : { type: 'stdio', ...stdio(s) }])) };
  } else {
    // claude-code (~/.claude.json) and cursor (.cursor/mcp.json) share the mcpServers shape
    obj = { mcpServers: Object.fromEntries(servers.map((s) => [s.name, http(s)])) };
  }
  return JSON.stringify(obj, null, 2);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/mcp.test.ts`
Expected: 4 passed

- [ ] **Step 5: 页面**

```astro
---
import BaseLayout from '../../layouts/BaseLayout.astro';
---
<BaseLayout
  title="MCP Config Generator — Claude Code, Cursor & VS Code"
  description="Generate MCP server configuration JSON for Claude Code, Cursor, and VS Code. Add servers once, export to every client."
>
  <h1>MCP Config Generator</h1>
  <label for="target">Target client</label>
  <select id="target">
    <option value="claude-code">Claude Code (~/.claude.json)</option>
    <option value="cursor">Cursor (.cursor/mcp.json)</option>
    <option value="vscode">VS Code (.vscode/mcp.json)</option>
  </select>
  <label for="name">Server name</label>
  <input id="name" placeholder="github" />
  <label for="cmd">Command (stdio server)</label>
  <input id="cmd" placeholder="npx -y @modelcontextprotocol/server-github" />
  <label for="url">— or URL (HTTP server)</label>
  <input id="url" placeholder="https://docs.example.com/mcp" />
  <button id="add">Add server</button>
  <h2 style="font-size:1rem">Added servers</h2>
  <ul id="list" style="color:var(--muted);font-size:.9rem"></ul>
  <pre id="out" class="result" style="white-space:pre-wrap">{ }</pre>
</BaseLayout>

<script>
  import { generateMcpConfig, type McpServer, type McpTarget } from '../../lib/mcp';
  const $ = (id: string) => document.getElementById(id)! as HTMLInputElement;
  const servers: McpServer[] = [];

  function render() {
    $('list').innerHTML = servers.map((s, i) =>
      `<li>${s.name} (${s.url ? 'http' : 'stdio'}) <button data-i="${i}" class="rm" style="padding:.1rem .5rem;font-size:.8rem">remove</button></li>`).join('');
    $('out').textContent = generateMcpConfig(($('target') as unknown as HTMLSelectElement).value as McpTarget, servers);
    document.querySelectorAll('.rm').forEach((b) =>
      b.addEventListener('click', () => { servers.splice(Number((b as HTMLElement).dataset.i), 1); render(); }));
  }

  $('add').addEventListener('click', () => {
    const name = $('name').value.trim();
    if (!name) return;
    const url = $('url').value.trim();
    const cmdStr = $('cmd').value.trim();
    const parts = cmdStr.split(/\s+/).filter(Boolean);
    servers.push(url ? { name, url } : { name, command: parts[0], args: parts.slice(1) });
    $('name').value = ''; $('cmd').value = ''; $('url').value = '';
    render();
  });
  $('target').addEventListener('change', render);
  render();
</script>
```

- [ ] **Step 6: 手动验证**

Run: `npm run dev` 打开 `/tools/mcp-config-generator/`
Expected: 添加 `github`（command `npx -y @modelcontextprotocol/server-github`）后 JSON 含 `mcpServers.github`；切换到 VS Code 变为 `servers.github.type === "stdio"`；remove 按钮可删

- [ ] **Step 7: Commit**

```bash
git add src/lib/mcp.ts src/lib/mcp.test.ts src/pages/tools/mcp-config-generator.astro && git commit -m "feat: mcp config generator"
```

---

### Task 11: 框架对比页 + 合规页 + 404

**Files:**
- Create: `src/data/frameworks.json`, `src/pages/compare/agent-frameworks.astro`, `src/pages/about.astro`, `src/pages/privacy.astro`, `src/pages/contact.astro`, `src/pages/404.astro`

- [ ] **Step 1: frameworks.json（数据标注 asOf，执行时可更新）**

```json
{
  "asOf": "2026-09-25",
  "frameworks": [
    {
      "name": "LangGraph",
      "maintainer": "LangChain",
      "language": "Python / JS",
      "strengths": "Graph-based state machines, fine-grained control over agent flow, strong persistence and human-in-the-loop support",
      "bestFor": "Complex multi-step workflows where you need explicit control over state and branching",
      "site": "https://langchain-ai.github.io/langgraph/"
    },
    {
      "name": "CrewAI",
      "maintainer": "CrewAI",
      "language": "Python",
      "strengths": "Role-based multi-agent teams, fast to prototype, gentle learning curve",
      "bestFor": "Multi-agent collaboration patterns (crew of specialists) without deep framework code",
      "site": "https://docs.crewai.com/"
    },
    {
      "name": "OpenAI Agents SDK",
      "maintainer": "OpenAI",
      "language": "Python / JS",
      "strengths": "Lightweight primitives (agents, handoffs, guardrails), first-class OpenAI model integration",
      "bestFor": "Teams standardized on OpenAI models who want a minimal, official abstraction",
      "site": "https://openai.github.io/openai-agents-python/"
    },
    {
      "name": "Claude Agent SDK",
      "maintainer": "Anthropic",
      "language": "Python / TS",
      "strengths": "Full coding-agent harness (file tools, bash, subagents, hooks, MCP), batteries included",
      "bestFor": "Agents that operate on code and filesystems; Claude-native workflows",
      "site": "https://code.claude.com/docs/en/agent-sdk"
    },
    {
      "name": "AutoGen",
      "maintainer": "Microsoft",
      "language": "Python / .NET",
      "strengths": "Conversation-driven multi-agent patterns, research heritage, event-driven architecture in v0.4",
      "bestFor": "Research and experimentation with conversational multi-agent topologies",
      "site": "https://microsoft.github.io/autogen/"
    }
  ]
}
```

- [ ] **Step 2: 对比页 compare/agent-frameworks.astro**

```astro
---
import BaseLayout from '../../layouts/BaseLayout.astro';
import data from '../../data/frameworks.json';
---
<BaseLayout
  title="AI Agent Framework Comparison 2026 — LangGraph vs CrewAI vs Agents SDK"
  description={`Compare the major AI agent frameworks: ${data.frameworks.map((f) => f.name).join(', ')}. Strengths, languages, and when to pick each.`}
>
  <h1>AI Agent Framework Comparison</h1>
  <p>Updated {data.asOf}. Quick take: pick by control vs speed-to-prototype, not by hype.</p>
  <div style="overflow-x:auto">
    <table>
      <thead><tr><th>Framework</th><th>Language</th><th>Strengths</th><th>Best for</th></tr></thead>
      <tbody>
        {data.frameworks.map((f) => (
          <tr>
            <td><a href={f.site} rel="noopener">{f.name}</a><br /><small style="color:var(--muted)">{f.maintainer}</small></td>
            <td>{f.language}</td>
            <td>{f.strengths}</td>
            <td>{f.bestFor}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
</BaseLayout>
```

- [ ] **Step 3: about.astro**

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout title="About AgentToolbox" description="Who builds AgentToolbox and why.">
  <h1>About</h1>
  <p>AgentToolbox is built by a working AI infrastructure engineer. Every tool here started as something I needed myself — comparing model API costs, estimating tokens, wiring MCP servers across editors.</p>
  <p>All tools run entirely in your browser. No accounts, no tracking of your inputs, no server-side processing.</p>
</BaseLayout>
```

- [ ] **Step 4: privacy.astro（AdSense 预备版）**

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout title="Privacy Policy" description="AgentToolbox privacy policy.">
  <h1>Privacy Policy</h1>
  <p>Last updated: 2026-09-25</p>
  <h2>What we collect</h2>
  <p>AgentToolbox tools run entirely in your browser. Text you enter into tools is processed locally and never sent to our servers.</p>
  <p>We use privacy-friendly, aggregate web analytics that do not use cookies to identify individuals.</p>
  <h2>Advertising</h2>
  <p>We may display ads served by third-party networks (such as Google AdSense). These vendors may use cookies to serve ads based on your prior visits to this or other websites. You can opt out of personalized advertising via <a href="https://www.google.com/settings/ads" rel="noopener">Google Ads Settings</a>.</p>
  <h2>Contact</h2>
  <p>Questions about this policy? See the <a href="/contact/">contact page</a>.</p>
</BaseLayout>
```

- [ ] **Step 5: contact.astro 与 404.astro**

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout title="Contact" description="Get in touch with AgentToolbox.">
  <h1>Contact</h1>
  <p>Feedback, tool requests, or bug reports are welcome: <a href="mailto:hello@agenttools.example.com">hello@agenttools.example.com</a>. (Replace with your real address before launch.)</p>
</BaseLayout>
```

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout title="Page not found" description="404">
  <h1>404 — Page not found</h1>
  <p><a href="/">Back to the toolbox</a>.</p>
</BaseLayout>
```

（contact 邮箱与 about 内容在 Task 12 域名确定后替换真实值。）

- [ ] **Step 6: 全量构建验证**

Run: `npm run build && npx vitest run`
Expected: 构建成功；14 个测试全过；`dist/sitemap-index.xml` 存在

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: framework comparison, about/privacy/contact, 404"
```

---

### Task 12: 部署 Cloudflare Pages（含人工步骤）

**Files:**
- Modify: `astro.config.mjs`（真实域名）, `public/robots.txt`（真实域名）, `src/pages/contact.astro`（真实邮箱）

- [ ] **Step 1: 注册域名（人工）**

在 Cloudflare Registrar（或 Namecheap）购买域名（.com 约 $10–11/年）。若在 Cloudflare 注册则自动接入其 DNS。

- [ ] **Step 2: 替换占位域名为真实域名**

`astro.config.mjs` 的 `site`、`public/robots.txt` 的 Sitemap 行、`contact.astro` 的邮箱。全局搜索 `agenttools.example.com` 确认无残留：

Run: `grep -r "agenttools.example.com" src/ public/ astro.config.mjs`
Expected: 无输出（全部已替换）

- [ ] **Step 3: 推送 Git 仓库（人工或 gh CLI）**

```bash
gh repo create agent-site --private --source=. --push
```

- [ ] **Step 4: Cloudflare Pages 接入（人工）**

Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git → 选仓库 → 构建配置：
- Framework preset: **Astro**
- Build command: `npm run build`
- Build output directory: `dist`
部署后在 Custom domains 绑定 Step 1 的域名。

- [ ] **Step 5: 线上验证（人工）**

- `https://<你的域名>/` 打开正常
- `https://<你的域名>/sitemap-index.xml` 返回 XML
- 四个工具页各跑一次核心交互
- Google Search Console 提交 sitemap（需先验证域名所有权）

- [ ] **Step 6: 开启 Cloudflare Web Analytics（人工）**

Dashboard → 你的站点 → Analytics & Logs → 启用 Web Analytics，脚本无需手动插入（Pages 自动注入 beacon）。

- [ ] **Step 7: 最终 Commit**

```bash
git add -A && git commit -m "chore: wire real domain and contact email"
```

---

## Phase 1 完成后（不在本计划内）

- 每工具页配 800+ 字说明文章（AI 起稿 + 人工审核），累计 20–30 篇后申请 AdSense
- Search Console 观察收录与查询词，据此决定下一个工具
- Phase 2（MCP 目录/模板库）另立计划

## Self-Review 记录

- **Spec 覆盖**：spec Phase 1 列了 7 个候选工具，本计划实现 5 个（成本计算器、token 估算器、system prompt 生成器、MCP 配置生成器、框架对比）+ 合规页 + 部署。上下文窗口计算器并入成本计算器（contextWindow 已在数据里，后续可加"能塞多少"展示）；模型定价对比表并入成本计算器的全模型对比。合理收敛，不算缺口。
- **占位符**：`agenttools.example.com` 与联系邮箱是明确的待替换占位，集中在 Task 12 Step 2 处理并有 grep 校验，可接受。GPT/Gemini 定价带 `verify: true` 与 asOf 标注，上线前人工核对。
- **类型一致性**：`ModelPricing`（cost.ts）与 models.json 字段名一致（`inputPerMTok`/`outputPerMTok`/`cacheReadPerMTok`/`contextWindow`）；`McpServer`/`McpTarget` 在 mcp.ts 定义、页面复用。
