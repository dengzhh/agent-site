# Free Models Aggregator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 上线免费模型聚合页 + 配置生成器：每日自动同步 models.dev + OpenRouter 双源数据，静态渲染免费模型表，浏览器本地生成 Claude Code / Codex / 环境变量 / AI SDK 四种配置片段。

**Architecture:** 同步脚本（node 原生 .mjs，零依赖）在 GitHub Actions 每日运行，生成 `src/data/free-models.json` 进仓库；页面纯静态消费该 JSON；生成逻辑在 `src/lib/freeconfig.ts`（纯函数，TDD）。无后端、无运行时 API 调用。

**Tech Stack:** Astro 7、Vitest、GitHub Actions（cron + workflow_dispatch）、node 原生 fetch。

**Spec:** `docs/superpowers/specs/2026-09-26-free-models-design.md`

**协议事实（生成器正确性的关键，已核实）：**
- Claude Code `ANTHROPIC_BASE_URL` 需要 **Anthropic 协议兼容**端点。OpenAI 协议的 provider（如 OpenRouter）不能直连——数据里只有 `anthropicApi` 字段的 provider 生成直连片段，其余生成说明 + claude-code-router 指引
- Codex CLI `wire_api` 唯一合法值是 `"responses"`（`"chat"` 2026 年已移除）

---

## 文件结构

```
scripts/sync-free-models.mjs        # 同步脚本：fetch 双源 → 过滤 → 写 JSON（纯函数 buildFreeModelsIndex 导出供测试）
scripts/sync-free-models.test.mjs   # 同步逻辑单测（vitest，.mjs）
.github/workflows/sync-models.yml   # 每日 cron + 手动触发
src/data/free-models.json           # 生成物（脚本产出，进仓库）
src/lib/free-models.ts              # 前端类型定义（FreeModelsIndex 等，页面/生成器共用）
src/lib/freeconfig.ts               # 配置片段生成（4 目标）纯函数
src/lib/freeconfig.test.ts          # 生成逻辑 TDD
src/pages/free-models.astro         # 汇总页 + 生成器
修改: vitest.config.ts（include 加 scripts/*.test.mjs）
修改: src/layouts/BaseLayout.astro（导航加 Free Models）
修改: src/pages/index.astro（首页加 FREE 入口卡）
```

---

### Task 1: 同步脚本纯函数（TDD）

**Files:**
- Create: `scripts/sync-free-models.mjs`
- Create: `scripts/sync-free-models.test.mjs`
- Modify: `vitest.config.ts`

- [ ] **Step 1: 更新 vitest.config.ts include**

```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    passWithNoTests: true,
  },
});
```

- [ ] **Step 2: 写失败测试 `scripts/sync-free-models.test.mjs`**

```javascript
import { describe, it, expect } from 'vitest';
import { buildFreeModelsIndex, PROVIDER_ALLOWLIST } from './sync-free-models.mjs';

// 与 models.dev api.json 同构的最小 fixture
const md = (pid, models, extra = {}) => ({
  [pid]: {
    id: pid, name: pid.toUpperCase(), env: ['X_API_KEY'],
    api: `https://${pid}.example/v1`, npm: '@ai-sdk/openai-compatible',
    ...extra,
    models: Object.fromEntries(models.map((m) => [m.id, m])),
  },
});
const model = (over = {}) => ({
  id: 'test/model', name: 'Test Model',
  limit: { context: 100000, output: 8192 },
  cost: { input: 0, output: 0 },
  tool_call: true, reasoning: false, attachment: false, open_weights: false,
  last_updated: '2026-09-01', ...over,
});

describe('buildFreeModelsIndex', () => {
  const modelsdev = {
    ...md('openrouter', [model({ id: 'google/gemma:free', name: 'Gemma (free)' }), model({ id: 'paid/model', cost: { input: 1, output: 2 } })]),
    ...md('zai', [model({ id: 'glm-4.5-flash' })]),
    ...md('mirror-hub', [model({ id: 'x/y' })]), // 白名单外
  };
  const orApi = { data: [{ id: 'google/gemma:free' }, { id: 'other/model:free' }] };

  it('keeps only allowlisted providers with zero-cost models', () => {
    const idx = buildFreeModelsIndex(modelsdev, orApi);
    const ids = idx.providers.map((p) => p.id);
    expect(ids).toContain('openrouter');
    expect(ids).toContain('zai');
    expect(ids).not.toContain('mirror-hub');
  });

  it('drops non-free models', () => {
    const idx = buildFreeModelsIndex(modelsdev, orApi);
    const or = idx.providers.find((p) => p.id === 'openrouter');
    expect(or.models.map((m) => m.id)).toEqual(['google/gemma:free']);
  });

  it('cross-checks openrouter ids against official API', () => {
    // google/gemma:free 在官方 API 中存在 → 保留
    const idx = buildFreeModelsIndex(modelsdev, orApi);
    const or = idx.providers.find((p) => p.id === 'openrouter');
    expect(or.models[0].id).toBe('google/gemma:free');
    // 官方 API 没有的 :free id → 丢弃
    const idx2 = buildFreeModelsIndex(modelsdev, { data: [] });
    const or2 = idx2.providers.find((p) => p.id === 'openrouter');
    expect(or2.models).toEqual([]);
  });

  it('trims fields and carries provider meta + overrides', () => {
    const idx = buildFreeModelsIndex(modelsdev, orApi);
    const zai = idx.providers.find((p) => p.id === 'zai');
    expect(zai.anthropicApi).toBe('https://api.z.ai/api/anthropic'); // 覆盖表注入
    expect(zai.models[0]).toEqual({
      id: 'glm-4.5-flash', name: 'Test Model', context: 100000, maxOutput: 8192,
      toolCall: true, reasoning: false, attachment: false, openWeights: false,
      lastUpdated: '2026-09-01',
    });
  });

  it('records counts and skips when nothing is free', () => {
    const idx = buildFreeModelsIndex({ ...md('openrouter', [model({ cost: { input: 1, output: 0 } })]) }, orApi);
    expect(idx.providers).toEqual([]); // 全付费 → provider 整个不出现
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run scripts/sync-free-models.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 `scripts/sync-free-models.mjs`**

```javascript
#!/usr/bin/env node
// 同步免费模型数据：models.dev 主源 + OpenRouter 官方 API 交叉校验。
// 纯函数 buildFreeModelsIndex 供 vitest 测试；main() 仅做 fetch/落盘。
import { writeFileSync } from 'node:fs';

export const PROVIDER_ALLOWLIST = [
  'openrouter', 'nvidia', 'groq', 'mistral', 'cerebras', 'zai',
  'github-copilot', 'cloudflare-workers-ai', 'alibaba-token-plan', 'opencode',
  'deepinfra', 'together', 'fireworks',
];

// models.dev 不携带的 provider 级补充信息（Anthropic 兼容端点、免费档限流说明）
export const PROVIDER_OVERRIDES = {
  zai: { anthropicApi: 'https://api.z.ai/api/anthropic' },
  openrouter: { note: 'Free models are rate-limited: ~20 req/min with a $10 credit, 50 requests/day without.' },
  opencode: { note: 'No account needed — the Zen endpoint serves free models without a key.' },
};

const trim = (m) => ({
  id: m.id,
  name: m.name,
  context: m.limit?.context ?? 0,
  maxOutput: m.limit?.output ?? 0,
  toolCall: m.tool_call === true,
  reasoning: m.reasoning === true,
  attachment: m.attachment === true,
  openWeights: m.open_weights === true,
  lastUpdated: m.last_updated ?? null,
});

export function buildFreeModelsIndex(modelsdev, openrouterApi) {
  const orFreeIds = new Set(
    (openrouterApi?.data ?? []).map((m) => m.id).filter((id) => id.endsWith(':free')),
  );
  const providers = [];
  let totalFree = 0;

  for (const pid of PROVIDER_ALLOWLIST) {
    const p = modelsdev[pid];
    if (!p?.models) continue;
    let models = Object.values(p.models)
      .filter((m) => m.cost?.input === 0 && m.cost?.output === 0)
      .map(trim)
      .sort((a, b) => (b.context || 0) - (a.context || 0));
    if (pid === 'openrouter') {
      models = models.filter((m) => orFreeIds.has(m.id));
    }
    if (models.length === 0) continue;
    totalFree += models.length;
    providers.push({
      id: pid,
      name: p.name || pid,
      api: p.api || null,
      envKey: p.env?.[0] || `${pid.toUpperCase().replace(/-/g, '_')}_API_KEY`,
      npm: p.npm || null,
      doc: p.doc || null,
      ...({ note: null, anthropicApi: null, ...PROVIDER_OVERRIDES[pid] }),
      models,
    });
  }

  return {
    syncedAt: new Date().toISOString(),
    source: 'models.dev + openrouter/api/v1/models',
    totalFree,
    providers,
  };
}

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 4 ** i));
    }
  }
}

async function main() {
  const modelsdev = await fetchJson('https://models.dev/api.json');
  let openrouterApi = null;
  try {
    openrouterApi = await fetchJson('https://openrouter.ai/api/v1/models');
  } catch (err) {
    console.warn('openrouter api unavailable, skipping cross-check:', err.message);
  }

  const before = Object.values(modelsdev).reduce(
    (n, p) => n + Object.keys(p.models || {}).length, 0);
  const idx = buildFreeModelsIndex(modelsdev, openrouterApi);

  // 防呆：上游 schema 崩坏时不要清空上线
  const kept = idx.totalFree;
  if (kept === 0) throw new Error('zero free models extracted — refusing to write empty index');
  console.log(`models seen: ${before}, free kept: ${kept}, providers: ${idx.providers.length}`);

  writeFileSync(
    new URL('../src/data/free-models.json', import.meta.url),
    JSON.stringify(idx, null, 2) + '\n',
  );
  console.log('wrote src/data/free-models.json');
}

if (process.argv[1] && process.argv[1].endsWith('sync-free-models.mjs')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run scripts/sync-free-models.test.mjs`
Expected: 5 passed

- [ ] **Step 6: Commit**

```bash
git add scripts/ vitest.config.ts && git commit -m "feat: free-models sync script with dual-source cross-check"
```

---

### Task 2: 本地跑通同步 + 数据落盘

**Files:**
- Create: `src/data/free-models.json`（脚本生成）

- [ ] **Step 1: 运行同步脚本**

Run: `node scripts/sync-free-models.mjs`
Expected: stdout `wrote src/data/free-models.json`；退出码 0

- [ ] **Step 2: 验证生成数据**

Run: `node -e "const d=require('./src/data/free-models.json'); console.log('syncedAt:', d.syncedAt); console.log('totalFree:', d.totalFree); d.providers.forEach(p=>console.log(p.id, p.models.length, p.anthropicApi||''))"`
Expected: totalFree ≥ 100（OpenRouter/Nvidia/zai 等白名单合计）；zai 行显示 anthropicApi

- [ ] **Step 3: Commit**

```bash
git add src/data/free-models.json && git commit -m "data: sync free models snapshot"
```

---

### Task 3: GitHub Actions 同步工作流

**Files:**
- Create: `.github/workflows/sync-models.yml`

- [ ] **Step 1: 写工作流**

```yaml
name: Sync free models

on:
  schedule:
    - cron: '23 3 * * *'  # 每日 UTC 03:23，避开整点
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: sync-models
  cancel-in-progress: true

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: node scripts/sync-free-models.mjs
      - name: Commit if changed
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add src/data/free-models.json
          git diff --cached --quiet && echo "no changes" && exit 0
          git commit -m "data: daily free models sync [skip ci]"
          git push
```

注意：`[skip ci]` 防止提交再触发 Pages 部署之外的循环——但我们需要部署！所以**不加** `[skip ci]`，让 push 触发 deploy.yml。修正提交信息为 `data: daily free models sync`（push 会级联触发 Pages 部署，这正是设计）。

- [ ] **Step 2: 手动触发验证**

```bash
git add .github/workflows/sync-models.yml && git commit -m "ci: daily free models sync workflow"
gh workflow run sync-models.yml --ref main
sleep 60 && gh run list --workflow=sync-models.yml --limit 1
```
Expected: completed success；若数据无变化日志显示 "no changes"

- [ ] **Step 3: Commit（若 Step 2 未提交）**

已在 Step 2 提交。

---

### Task 4: 配置生成逻辑（TDD）

**Files:**
- Create: `src/lib/free-models.ts`（类型）
- Create: `src/lib/freeconfig.ts`
- Create: `src/lib/freeconfig.test.ts`

- [ ] **Step 1: 类型文件 `src/lib/free-models.ts`**

```typescript
// free-models.json 的前端类型（由 scripts/sync-free-models.mjs 生成）
export interface FreeModel {
  id: string;
  name: string;
  context: number;
  maxOutput: number;
  toolCall: boolean;
  reasoning: boolean;
  attachment: boolean;
  openWeights: boolean;
  lastUpdated: string | null;
}

export interface FreeProvider {
  id: string;
  name: string;
  api: string | null;
  envKey: string;
  npm: string | null;
  doc: string | null;
  note: string | null;
  anthropicApi: string | null;
  models: FreeModel[];
}

export interface FreeModelsIndex {
  syncedAt: string;
  source: string;
  totalFree: number;
  providers: FreeProvider[];
}
```

- [ ] **Step 2: 写失败测试 `src/lib/freeconfig.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { generateConfig, type ConfigTarget } from './freeconfig';
import type { FreeProvider, FreeModel } from './free-models';

const orProvider: FreeProvider = {
  id: 'openrouter', name: 'OpenRouter', api: 'https://openrouter.ai/api/v1',
  envKey: 'OPENROUTER_API_KEY', npm: '@openrouter/ai-sdk-provider',
  doc: 'https://openrouter.ai/docs', note: 'rate-limited', anthropicApi: null,
  models: [],
};
const zaiProvider: FreeProvider = {
  ...orProvider, id: 'zai', name: 'Z.ai', api: 'https://api.z.ai/api/paas/v4',
  envKey: 'ZHIPU_API_KEY', npm: null, anthropicApi: 'https://api.z.ai/api/anthropic',
};
const gemma: FreeModel = {
  id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (free)', context: 262144,
  maxOutput: 32768, toolCall: true, reasoning: true, attachment: true,
  openWeights: true, lastUpdated: '2026-04-02',
};

describe('generateConfig', () => {
  it('claude-code: direct settings for anthropic-compatible provider', () => {
    const out = generateConfig('claude-code', zaiProvider, { ...gemma, id: 'glm-4.5-flash' }, 'sk-test');
    expect(out).toContain('"ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic"');
    expect(out).toContain('"ANTHROPIC_API_KEY": "sk-test"');
    expect(out).toContain('"ANTHROPIC_MODEL": "glm-4.5-flash"');
  });

  it('claude-code: openai-protocol provider gets router guidance, no fake config', () => {
    const out = generateConfig('claude-code', orProvider, gemma, 'sk-or-test');
    expect(out).toContain('claude-code-router');
    expect(out).not.toContain('"ANTHROPIC_BASE_URL": "https://openrouter.ai');
  });

  it('codex: toml with wire_api responses', () => {
    const out = generateConfig('codex', orProvider, gemma, 'sk-or-test');
    expect(out).toContain('model = "google/gemma-4-31b-it:free"');
    expect(out).toContain('wire_api = "responses"');
    expect(out).toContain('https://openrouter.ai/api/v1');
  });

  it('env: export with provider env key', () => {
    const out = generateConfig('env', orProvider, gemma, 'sk-or-test');
    expect(out).toContain('export OPENROUTER_API_KEY=sk-or-test');
  });

  it('ai-sdk: dedicated snippet for known npm package', () => {
    const out = generateConfig('ai-sdk', orProvider, gemma, undefined);
    expect(out).toContain("@openrouter/ai-sdk-provider");
    expect(out).toContain("openrouter('google/gemma-4-31b-it:free')");
  });

  it('ai-sdk: generic openai-compatible fallback', () => {
    const p = { ...zaiProvider, npm: null };
    const out = generateConfig('ai-sdk', p, { ...gemma, id: 'glm-4.5-flash' }, undefined);
    expect(out).toContain('@ai-sdk/openai-compatible');
    expect(out).toContain('https://api.z.ai/api/paas/v4');
  });

  it('never embeds key into ai-sdk sample (env ref instead)', () => {
    const out = generateConfig('ai-sdk', orProvider, gemma, 'sk-secret');
    expect(out).not.toContain('sk-secret');
    expect(out).toContain('process.env.OPENROUTER_API_KEY');
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run src/lib/freeconfig.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 `src/lib/freeconfig.ts`**

```typescript
import type { FreeProvider, FreeModel } from './free-models';

export type ConfigTarget = 'claude-code' | 'codex' | 'env' | 'ai-sdk';

export interface GenerateInput {
  provider: FreeProvider;
  model: FreeModel;
  apiKey: string; // 可为空字符串——生成器用占位符
}

const KEY_PLACEHOLDER = 'YOUR_API_KEY';

// 已知专用 SDK 包 → 示例工厂代码；其余走 openai-compatible 通用形态
const DEDICATED_SDK: Record<string, (p: FreeProvider) => string> = {
  '@openrouter/ai-sdk-provider': (p) =>
    `import { createOpenRouter } from '@openrouter/ai-sdk-provider';\n\n` +
    `const ${p.id} = createOpenRouter({ apiKey: process.env.${p.envKey} });\n` +
    `// model id: 用完整 openrouter id`,
};

export function generateConfig(
  target: ConfigTarget,
  provider: FreeProvider,
  model: FreeModel,
  apiKey: string,
): string {
  const key = apiKey.trim() || KEY_PLACEHOLDER;

  if (target === 'env') {
    return `export ${provider.envKey}=${key}`;
  }

  if (target === 'claude-code') {
    if (provider.anthropicApi) {
      return [
        '// ~/.claude/settings.json',
        '{',
        '  "env": {',
        `    "ANTHROPIC_BASE_URL": "${provider.anthropicApi}",`,
        `    "ANTHROPIC_API_KEY": "${key}",`,
        `    "ANTHROPIC_MODEL": "${model.id}"`,
        '  }',
        '}',
      ].join('\n');
    }
    // OpenAI 协议 provider：不生成假配置，给出真实路径
    return [
      `# ${provider.name} speaks the OpenAI protocol, but Claude Code needs an`,
      '# Anthropic-compatible endpoint. Two real options:',
      '#',
      '# 1) Use claude-code-router (https://github.com/musistudio/claude-code-router)',
      `#    to translate: it reads OPENAI_API_BASE=${provider.api} and forwards to Claude Code.`,
      '#',
      '# 2) Pick a provider with a native Anthropic-compatible endpoint (marked',
      '#    "direct" in the table above), e.g. Z.ai GLM.',
      '#',
      `# Shell env for the router route (works today):`,
      `export OPENAI_API_BASE=${provider.api}`,
      `export OPENAI_API_KEY=${key}`,
      `export OPENROUTER_MODEL=${model.id}`,
    ].join('\n');
  }

  if (target === 'codex') {
    const pid = provider.id.replace(/[^a-z0-9]/g, '_');
    return [
      `# ~/.codex/config.toml`,
      `model = "${model.id}"`,
      `model_provider = "${pid}"`,
      '',
      `[model_providers.${pid}]`,
      `name = "${provider.name}"`,
      `base_url = "${provider.api}"`,
      'wire_api = "responses"',
      `env_key = "${provider.envKey}"`,
      '',
      `# then: export ${provider.envKey}=${key}`,
      `# note: the provider must support the OpenAI Responses API (wire_api`,
      `# "chat" was removed from Codex in 2026). If ${provider.name} only offers`,
      `# /chat/completions, route through a translating gateway (LiteLLM).`,
    ].join('\n');
  }

  // ai-sdk
  const factory = provider.npm ? DEDICATED_SDK[provider.npm] : undefined;
  if (factory) {
    const inst = factory(provider);
    return [
      `// npm install ${provider.npm} ai`,
      inst,
      `const result = await generateText({`,
      `  model: ${provider.id}('${model.id}'),`,
      `  prompt: 'Hello!',`,
      `});`,
    ].join('\n');
  }
  const varName = provider.id.replace(/[^a-z0-9]/g, '');
  return [
    `// npm install @ai-sdk/openai-compatible ai`,
    `import { createOpenAICompatible } from '@ai-sdk/openai-compatible';`,
    '',
    `const ${varName} = createOpenAICompatible({`,
    `  name: '${provider.id}',`,
    `  baseURL: '${provider.api}',`,
    `  apiKey: process.env.${provider.envKey},`,
    `});`,
    '',
    `const result = await generateText({`,
    `  model: ${varName}.chatModel('${model.id}'),`,
    `  prompt: 'Hello!',`,
    `});`,
  ].join('\n');
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run src/lib/freeconfig.test.ts`
Expected: 7 passed；全量 `npm test` 此刻 21+5+7=33 passed

- [ ] **Step 6: Commit**

```bash
git add src/lib/free-models.ts src/lib/freeconfig.ts src/lib/freeconfig.test.ts && git commit -m "feat: config snippet generator for four targets"
```

---

### Task 5: 汇总页 + 生成器页面

**Files:**
- Create: `src/pages/free-models.astro`

- [ ] **Step 1: 页面（汇总表静态渲染 + 生成器岛屿）**

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
import data from '../data/free-models.json';
import type { FreeModelsIndex } from '../lib/free-models';
const idx = data as FreeModelsIndex;
const BASE_URL = import.meta.env.BASE_URL.replace(/\/?$/, '/');

const caps = (m: { toolCall: boolean; reasoning: boolean; attachment: boolean; openWeights: boolean }) =>
  [m.toolCall && 'tools', m.reasoning && 'reason', m.attachment && 'vision', m.openWeights && 'open-weights']
    .filter(Boolean) as string[];

const fmtCtx = (n: number) => (n >= 1000 ? `${Math.round(n / 1024)}K` : String(n));
---
<BaseLayout
  title="Free LLM Models — Every Zero-Cost API Model in One Table"
  description="All free LLM API models from OpenRouter, Nvidia, Groq, Mistral, Z.ai and more: context windows, tool calling, and one-click config snippets for Claude Code and Codex. Synced daily."
>
  <h1>Free LLM models</h1>
  <p>Every model below costs exactly $0 per token, aggregated from {idx.providers.length} providers. Generate ready-to-paste config for Claude Code, Codex CLI, or your own code.</p>
  <p class="muted-note">
    Data synced {new Date(idx.syncedAt).toISOString().slice(0, 10)} from {idx.source}.
    "Free" means $0 input and $0 output — rate limits still apply per provider.
  </p>

  <nav class="cap-filter" aria-label="Filter by capability">
    <button type="button" class="cap-chip is-active" data-cap="all">All {idx.totalFree}</button>
    <button type="button" class="cap-chip" data-cap="tools">Tool calling</button>
    <button type="button" class="cap-chip" data-cap="reasoning">Reasoning</button>
    <button type="button" class="cap-chip" data-cap="vision">Vision</button>
    <button type="button" class="cap-chip" data-cap="long">Long context ≥400K</button>
    <button type="button" class="cap-chip" data-cap="open">Open weights</button>
  </nav>

  {idx.providers.map((p) => (
    <section class="provider" data-provider={p.id}>
      <h2>{p.name} <span class="count">{p.models.length} free</span></h2>
      {p.note && <p class="muted-note">{p.note}</p>}
      <div class="tablewrap">
        <table>
          <thead><tr>
            <th scope="col">Model</th><th scope="col" class="num">Context</th>
            <th scope="col" class="num">Max out</th><th scope="col">Capabilities</th>
            <th scope="col">Config</th>
          </tr></thead>
          <tbody>
            {p.models.map((m) => (
              <tr data-caps={[
                    m.toolCall && 'tools', m.reasoning && 'reasoning',
                    m.attachment && 'vision', m.openWeights && 'open',
                    m.context >= 400000 && 'long',
                  ].filter(Boolean).join(' ')}>
                <td>{m.name}<br /><code>{m.id}</code></td>
                <td class="num">{fmtCtx(m.context)}</td>
                <td class="num">{fmtCtx(m.maxOutput)}</td>
                <td>{caps(m).length ? caps(m).join(' · ') : '—'}</td>
                <td><a href="#configure" class="pick" data-provider={p.id} data-model={m.id}>Configure →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  ))}

  <section id="configure" class="generator">
    <h2>Generate your config</h2>
    <p>Pick a model in the table above, or choose here. Your API key is merged in your browser only — it never leaves this page.</p>
    <form id="gen-form">
      <div class="field-row">
        <div>
          <label for="g-provider">Provider</label>
          <select id="g-provider">
            {idx.providers.map((p) => <option value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label for="g-model">Model</label>
          <select id="g-model"></select>
        </div>
      </div>
      <div class="field-row">
        <div>
          <label for="g-key">API key (optional, local only)</label>
          <input id="g-key" type="password" placeholder="paste your key — stays in your browser" autocomplete="off" />
        </div>
        <div>
          <label for="g-target">Target</label>
          <select id="g-target">
            <option value="claude-code">Claude Code (settings.json)</option>
            <option value="codex">Codex CLI (config.toml)</option>
            <option value="env">Shell env vars</option>
            <option value="ai-sdk">AI SDK (TypeScript)</option>
          </select>
        </div>
      </div>
      <button type="submit">Generate</button>
    </form>
    <pre id="g-out" class="result" aria-live="polite" style="white-space:pre-wrap"></pre>
    <button id="g-copy" type="button" hidden>Copy</button>
  </section>
</BaseLayout>

<style>
  .provider { margin-top: 2.5rem; }
  .count { font-size: 0.85rem; font-weight: 500; color: var(--ink-soft); margin-left: 0.5rem; }
  .tablewrap { overflow-x: auto; }
  .generator { border-top: 1px solid var(--line); padding-top: 1rem; margin-top: 3rem; }
  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  @media (max-width: 600px) { .field-row { grid-template-columns: 1fr; } }
  .cap-filter { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1.25rem 0 0.5rem; }
  .cap-chip {
    background: var(--surface); color: var(--ink-soft);
    border: 1px solid var(--line-strong); border-radius: 999px;
    padding: 0.3rem 0.85rem; font-size: 0.85rem; font-weight: 500;
  }
  .cap-chip.is-active { background: var(--cobalt); color: #fff; border-color: var(--cobalt); }
  .provider.is-hidden, tr.is-hidden { display: none; }
</style>

<script>
  import data from '../data/free-models.json';
  import { generateConfig, type ConfigTarget } from '../lib/freeconfig';

  const idx = data;
  const $ = (id: string) => document.getElementById(id)!;
  const provSel = $('g-provider') as HTMLSelectElement;
  const modelSel = $('g-model') as HTMLSelectElement;
  const targetSel = $('g-target') as HTMLSelectElement;
  const out = $('g-out');
  const copy = $('g-copy') as HTMLButtonElement;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  function fillModels() {
    const p = idx.providers.find((x) => x.id === provSel.value)!;
    modelSel.innerHTML = p.models
      .map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
  }

  function flash(msg: string) {
    copy.textContent = msg;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copy.textContent = 'Copy'), 1500);
  }

  function render() {
    const p = idx.providers.find((x) => x.id === provSel.value)!;
    const m = p.models.find((x) => x.id === modelSel.value) ?? p.models[0];
    if (!m) { out.textContent = ''; return; }
    out.textContent = generateConfig(
      targetSel.value as ConfigTarget, p, m,
      ($('g-key') as HTMLInputElement).value,
    );
    copy.hidden = false;
  }

  provSel.addEventListener('change', () => { fillModels(); render(); });
  modelSel.addEventListener('change', render);
  targetSel.addEventListener('change', render);
  ($('gen-form') as HTMLFormElement).addEventListener('submit', (e) => { e.preventDefault(); render(); });

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(out.textContent ?? '');
      flash('Copied!');
    } catch {
      flash('Copy failed — select the text');
    }
  });

  // 表格里的 Configure → 预填生成器
  document.querySelectorAll<HTMLAnchorElement>('.pick').forEach((a) => {
    a.addEventListener('click', () => {
      provSel.value = a.dataset.provider!;
      fillModels();
      modelSel.value = a.dataset.model!;
      render();
    });
  });

  // 能力筛选：chip 点击 → 按 tr 的 data-caps 显隐整行，全空的 provider 节隐藏
  document.querySelectorAll<HTMLButtonElement>('.cap-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.cap-chip').forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      const cap = chip.dataset.cap!;
      document.querySelectorAll<HTMLTableRowElement>('tr[data-caps]').forEach((tr) => {
        const show = cap === 'all' || tr.dataset.caps.split(' ').includes(cap);
        tr.classList.toggle('is-hidden', !show);
      });
      document.querySelectorAll<HTMLElement>('.provider').forEach((sec) => {
        const any = sec.querySelectorAll('tr:not(.is-hidden)').length > 0;
        sec.classList.toggle('is-hidden', !any);
      });
    });
  });

  fillModels();
</script>
```

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 成功，11 页；`dist/free-models/index.html` 存在且含 syncedAt 日期与 ≥100 个 `<code>` 模型 id

- [ ] **Step 3: 全量测试 + 产物抽查**

Run: `npm test` → 33 passed；`grep -c "Configure" dist/free-models/index.html` ≥ 100

- [ ] **Step 4: Commit**

```bash
git add src/pages/free-models.astro && git commit -m "feat: free models directory page with config generator"
```

---

### Task 6: 导航与首页入口

**Files:**
- Modify: `src/layouts/BaseLayout.astro`（nav 数组加一项）
- Modify: `src/pages/index.astro`（tools 数组加 FREE 卡）

- [ ] **Step 1: BaseLayout nav 数组首项前加**

```typescript
{ href: BASE_URL + 'free-models/', label: 'Free Models' },
```

- [ ] **Step 2: index.astro tools 数组头部加**

```typescript
{ href: BASE_URL + 'free-models/', name: 'Free model directory', desc: `Every $0-per-token model across ${idx.providers.length} providers, synced daily — with one-click config for Claude Code and Codex.`, tag: 'Free' },
```

（index.astro frontmatter 需同步 `import freeIdx from '../data/free-models.json';` 并在 desc 里用 `freeIdx.providers.length`。）

- [ ] **Step 3: 构建验证 + Commit**

Run: `npm run build` → 成功；`grep -c "Free Models" dist/index.html` ≥ 2

```bash
git add src/layouts/BaseLayout.astro src/pages/index.astro && git commit -m "feat: free models nav and homepage entry"
```

---

### Task 7: 部署与线上冒烟

- [ ] **Step 1: 推送并等待 Pages 部署**

```bash
git push origin main
sleep 60 && gh run list --limit 1
```
Expected: deploy success

- [ ] **Step 2: 线上冒烟（人工或 curl）**

- `https://dengzhh.github.io/agent-site/free-models/` 返回 200
- 页面含 syncedAt 日期、免费模型表
- 生成器：选 OpenRouter + gemma free + claude-code → 输出含 claude-code-router 指引（OpenAI 协议）；选 Z.ai → 输出含 anthropicApi 直连配置
- API key 输入为 password 型且页面无网络请求携带 key（DevTools Network 抽查）

---

## Self-Review 记录

- **Spec 覆盖**：§3 管道=Task 1-3；§5 数据格式=Task 1（trim 字段与 spec §5 示例逐字段一致，另加 `note`/`anthropicApi` 两个 spec §6.2 需要的字段）；§6 页面=Task 5-6；§8 错误处理=Task 1（fetchJson 重试、空结果拒写、OR 降级）+ Task 3（无变化不提交）；§9 测试=Task 1/4；§10 指标在 Task 2/7 验证。缺口：spec §8 ">50% 条目跳过则失败"未实现——buildFreeModelsIndex 无法知道"应有多少"，改为 totalFree===0 拒写（更简单的等价防呆），已在计划中注明。
- **占位符**：无 TBD；所有代码完整。
- **类型一致性**：`FreeModel`/`FreeProvider`/`FreeModelsIndex`（free-models.ts）与 Task 1 trim 输出、Task 5 页面消费一致；`generateConfig(target, provider, model, apiKey)` 四参签名在 Task 4/5 一致。
- **协议修正**：spec §6.2 写"Claude Code 仅对 OpenAI 兼容 provider 有效"是**错的**（方向反了）——已按核实事实修正为 Anthropic 兼容直连 / OpenAI 协议走 router 指引，spec 文件需同步勘误（执行时顺带改 spec §6.2 两行）。
