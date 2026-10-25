# 付费热门模型榜 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/paid-models` 页：OpenRouter 周用量 × 聚合价的付费热门模型榜，可排序，Configure/Chat 跨页链接复用免费页抽屉。

**Architecture:** 每日 sync 工作流新增 `scripts/sync-paid-models.mjs`（纯函数 `buildPaidBoard` + fetch/落盘），产出 `src/data/paid-models.json`；静态页 `paid-models.astro` 渲染表格 + 小段排序 JS；按钮是带 query 的链接跳到 `/free-models/?…`，免费页加 URL 参数处理器调已有 `openChat()`/`openConfig()`。

**Tech Stack:** Astro 5 静态站、vitest（仓库根 `npm test`）、Node 24 原生 fetch、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-10-25-paid-models-board-design.md`

## 探测事实（2026-10-24 实测，已验证，勿重新推导）

- `GET https://openrouter.ai/api/frontend/v1/rankings/models`（公开无 key）→ `{data:[{date, model_permaslug, variant, total_prompt_tokens, total_completion_tokens, …}]}`，滚动 6 天，variant ∈ {free, standard, batch}。
- `GET https://openrouter.ai/api/v1/models`（公开无 key）→ `{data:[{id, canonical_slug, name, context_length, pricing:{prompt, completion}（$/token 字符串）, supported_parameters, architecture:{input_modalities}, top_provider:{max_completion_tokens}}]}`，467 个 id，**无任何用量字段**。
- **关联**：permaslug 与 models id 精确相等仅 20%（rankings 用带 `-YYYYMMDD` 后缀的 slug）；剥掉日期后缀兜底后，**按 token 用量加权覆盖率 95.2%**（漏掉的 4.8% 多是 0 热度 embed/TTS 长尾）。策略：`resolve(slug) = 精确命中 ?? 剥后缀命中`，热度按**resolve 后的 id** 聚合（同族日期快照自然合并）。
- 同族不同 id 仍可能并存（canonical_slug 相同），需二次按 `canonical_slug` 去重留最热。

## 命令约定

- 仓库根测试：`npm test`（vitest run，含 `scripts/*.test.mjs`）。类型检查：`npx tsc --noEmit`。
- 网关测试与本任务无关，最终验证时跑 `cd packages/agent-server && npm test`。
- dev 服务器：`npx astro dev --background`，停/看日志用 `npx astro dev stop|logs`。
- 提交信息英文，结尾 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

---

### Task 1: 同步脚本 `sync-paid-models.mjs`（TDD）

> **勘误（2026-10-25 代码审查后）**：本任务的参考 fixture 有三处缺陷，实施后已按审查意见修复：
> ① `f/free-ish` 原先没有 rankings 行，付费过滤用例空转（删掉过滤代码测试照样绿）——已补
> `RANK('f/free-ish', …)`；② `d/d`/`e/e` 缺模型条目，变体过滤的回归只能靠无关报错间接抓住——已补；
> ③ 覆盖率防线有零值盲区（上游字段改名 → totalRaw=0 → 防线跳过 → 发空榜）——已改为
> `standardRows>0 && ratio<0.5` 抛错，并加了字段改名/字符串数值两个用例（共 9 个）。
> 下文 Step 1/Step 3 的代码块是**修复前**的原始参考，以仓库实际代码为准。

**Files:**
- Create: `scripts/sync-paid-models.mjs`
- Test: `scripts/sync-paid-models.test.mjs`
- Create（由脚本生成）: `src/data/paid-models.json`

- [ ] **Step 1: 写失败测试**

创建 `scripts/sync-paid-models.test.mjs`：

```js
import { describe, it, expect } from 'vitest';
import { buildPaidBoard } from './sync-paid-models.mjs';

// 合成 fixture：字段形状照 §探测事实，不联网。
const RANK = (slug, day, pt, ct, variant = 'standard') => ({
  date: day, model_permaslug: slug, variant,
  total_prompt_tokens: pt, total_completion_tokens: ct,
});
const MODEL = (id, o = {}) => ({
  id, name: id, canonical_slug: o.canonical ?? id,
  context_length: o.ctx ?? 128000,
  pricing: { prompt: String(o.in ?? 0.000001), completion: String(o.out ?? 0.000002) },
  supported_parameters: o.params ?? ['tools'],
  architecture: { input_modalities: o.mods ?? ['text'] },
  top_provider: { max_completion_tokens: o.maxOut ?? 8192 },
});

describe('buildPaidBoard', () => {
  const rankings = { data: [
    // 两天聚合：同 slug 相加
    RANK('a/a-20261019', '2026-10-19', 100, 50), RANK('a/a-20261019', '2026-10-20', 30, 20),
    RANK('b/b', '2026-10-19', 10, 5),                    // 精确命中
    RANK('c/c-20261024', '2026-10-19', 3, 2),            // 剥后缀命中 → c/c
    RANK('d/d', '2026-10-19', 999, 999, 'free'),         // free 变体排除
    RANK('e/e', '2026-10-19', 999, 999, 'batch'),        // batch 变体排除
    RANK('x/x', '2026-10-19', 500, 500),                 // models 里没有 → 跳过（但计覆盖率）
    RANK('z/z', '2026-10-19', 10, 5),                    // 同族不同 id，热度低于 a → canonical 去重丢弃
  ] };
  const models = { data: [
    MODEL('a/a-20261019', { canonical: 'fam-a', in: 0.0000001, out: 0.0000005 }),
    MODEL('a/a-20261010', { canonical: 'fam-a' }),       // 同族旧快照，剥后缀同 id，聚合时已合并
    MODEL('b/b'), MODEL('c/c'),
    MODEL('z/z', { canonical: 'fam-a' }),
    MODEL('f/free-ish', { in: 0, out: 0 }),              // 全零价 → 付费过滤丢弃
  ] };
  // 覆盖率防线要看到"能 join 的大头"：没有这条时 joined/raw ≈ 18% 会误触发
  // coverage 防线（x/x 1000 加入 raw 但 join 不上）。
  rankings.data.push(RANK('a/a-20261019', '2026-10-21', 5000, 3000));

  it('aggregates days, resolves dated slugs, and sorts by heat desc', () => {
    const board = buildPaidBoard(rankings, models);
    // a 总量 100+50+30+20+5000+3000=8200；b=15；c=5
    expect(board.models.map((m) => m.id)).toEqual(['a/a-20261019', 'b/b', 'c/c']);
    expect(board.models[0].heat.promptTokens).toBe(5130);
    expect(board.models[0].heat.completionTokens).toBe(3070);
    expect(board.windowDays).toBe(3);
    expect(board.totalCandidates).toBe(3);
  });

  it('converts $/token to $/1M and keeps 3 significant digits', () => {
    const board = buildPaidBoard(rankings, models);
    expect(board.models[0].price).toEqual({ input: 0.1, output: 0.5 });
  });

  it('dedupes by canonical_slug keeping the hottest', () => {
    const board = buildPaidBoard(rankings, models);
    expect(board.models.some((m) => m.id === 'z/z')).toBe(false);
    expect(board.models.filter((m) => m.canonicalSlug === 'fam-a')).toHaveLength(1);
  });

  it('drops zero-price models and derives capabilities from models api', () => {
    const board = buildPaidBoard(rankings, models);
    expect(board.models.some((m) => m.id === 'f/free-ish')).toBe(false);
    const top = board.models[0];
    expect(top.toolCall).toBe(true); // supported_parameters 含 'tools'
    expect(top.detailUrl).toBe('https://openrouter.ai/a/a-20261019');
    expect(top.context).toBe(128000);
    expect(top.maxOutput).toBe(8192);
  });

  it('cuts to topN with a deterministic tie-break', () => {
    const rs = { data: [] };
    const ms = { data: [] };
    for (let i = 0; i < 35; i++) {
      rs.data.push(RANK(`m/m${String(i).padStart(2, '0')}`, '2026-10-19', 100, 0));
      ms.data.push(MODEL(`m/m${String(i).padStart(2, '0')}`));
    }
    const board = buildPaidBoard(rs, ms); // 热度全平 → id 升序 tie-break
    expect(board.models).toHaveLength(30);
    expect(board.models[0].id).toBe('m/m00');
    expect(board.totalCandidates).toBe(35);
  });

  it('throws when joined volume coverage collapses (upstream shape change)', () => {
    const badModels = { data: [MODEL('only/one')] };
    expect(() => buildPaidBoard(rankings, badModels)).toThrow(/coverage/);
  });

  it('throws when the result would be empty', () => {
    expect(() => buildPaidBoard({ data: [] }, models)).toThrow(/empty/);
    expect(() => buildPaidBoard({ data: [RANK('d/d', '2026-10-19', 1, 1, 'free')] }, models)).toThrow(/empty/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run scripts/sync-paid-models.test.mjs`
Expected: FAIL（`Cannot find module './sync-paid-models.mjs'`）

- [ ] **Step 3: 实现脚本**

创建 `scripts/sync-paid-models.mjs`：

```js
#!/usr/bin/env node
// 同步付费热门模型榜：OpenRouter rankings（真实用量）× models api（价格/能力）。
// 纯函数 buildPaidBoard 供 vitest；main() 只做 fetch/落盘。
import { writeFileSync, renameSync, readFileSync } from 'node:fs';

const TOP_N = 30;
const RANKINGS_URL = 'https://openrouter.ai/api/frontend/v1/rankings/models';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';

// rankings 用带 -YYYYMMDD 后缀的 permaslug，models api 的 id 多数不带后缀
// （2026-10-24 实测：精确命中仅 20% 模型数 / 1.5% 用量；剥后缀兜底后覆盖 95.2%
// 用量）。热度必须按 resolve 出来的 models id 聚合——同族日期快照才会合并。
const resolveId = (slug, ids) =>
  ids.has(slug) ? slug : (ids.has(slug.replace(/-[0-9]{8}$/, '')) ? slug.replace(/-[0-9]{8}$/, '') : null);

export function buildPaidBoard(rankings, modelsApi, opts = {}) {
  const rows = Array.isArray(rankings?.data) ? rankings.data : [];
  const models = Array.isArray(modelsApi?.data) ? modelsApi.data : [];
  const byId = new Map(models.map((m) => [m.id, m]));

  // 1) 只取 standard；2) 聚合到 resolved id
  const heat = new Map(); // resolvedId -> {prompt, completion}
  const rawHeat = new Map(); // 原始 slug 总量（算覆盖率用，不能被 resolve 抬高）
  for (const r of rows) {
    if (r?.variant !== 'standard' || !r?.model_permaslug) continue;
    const pt = r.total_prompt_tokens ?? 0, ct = r.total_completion_tokens ?? 0;
    rawHeat.set(r.model_permaslug, (rawHeat.get(r.model_permaslug) ?? 0) + pt + ct);
    const id = resolveId(r.model_permaslug, byId);
    if (!id) continue;
    const acc = heat.get(id) ?? { prompt: 0, completion: 0 };
    acc.prompt += pt; acc.completion += ct;
    heat.set(id, acc);
  }

  // 用量覆盖率防线：rankings 大改版时宁可同步失败，不悄悄发残榜
  const totalRaw = [...rawHeat.values()].reduce((n, v) => n + v, 0);
  const joined = [...heat.values()].reduce((n, a) => n + a.prompt + a.completion, 0);
  if (totalRaw > 0 && joined / totalRaw < 0.5) {
    throw new Error(`join coverage ${(joined / totalRaw * 100).toFixed(1)}% < 50% — upstream shape likely changed`);
  }

  // 3) 付费过滤 + canonical 去重（同族不同 id 留最热）
  const heatOf = (a) => a.prompt + a.completion;
  const byCanonical = new Map();
  for (const [id, h] of heat) {
    const m = byId.get(id);
    const pin = Number(m.pricing?.prompt ?? 0), pout = Number(m.pricing?.completion ?? 0);
    if (!(pin > 0 || pout > 0)) continue; // 付费榜：全零价归免费页
    const key = m.canonical_slug || id;
    const prev = byCanonical.get(key);
    if (!prev || heatOf(h) > heatOf(prev.heat)) byCanonical.set(key, { m, id, heat: h });
  }

  const candidates = [...byCanonical.values()]
    .sort((a, b) => heatOf(b.heat) - heatOf(a.heat) || (a.id < b.id ? -1 : 1));
  if (candidates.length === 0) throw new Error('zero paid models — refusing to write empty board');

  const perM = (v) => Number((Number(v) * 1e6).toPrecision(3));
  return {
    syncedAt: new Date().toISOString(),
    source: 'openrouter rankings + models api',
    windowDays: new Set(rows.map((r) => r.date)).size,
    totalCandidates: candidates.length,
    models: candidates.slice(0, opts.topN ?? TOP_N).map(({ m, id, heat: h }) => ({
      id,
      name: m.name ?? id,
      canonicalSlug: m.canonical_slug ?? null,
      heat: { promptTokens: h.prompt, completionTokens: h.completion },
      price: { input: perM(m.pricing.prompt), output: perM(m.pricing.completion) },
      context: m.context_length ?? 0,
      maxOutput: m.top_provider?.max_completion_tokens ?? null,
      toolCall: (m.supported_parameters ?? []).includes('tools'),
      reasoning: (m.supported_parameters ?? []).includes('reasoning'),
      attachment: (m.architecture?.input_modalities ?? []).includes('image'),
      detailUrl: `https://openrouter.ai/${id}`,
    })),
  };
}

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 4 ** i));
    }
  }
}

async function main() {
  const [rankings, modelsApi] = await Promise.all([fetchJson(RANKINGS_URL), fetchJson(MODELS_URL)]);
  const board = buildPaidBoard(rankings, modelsApi);
  console.log(`paid board: ${board.models.length} of ${board.totalCandidates} candidates, window ${board.windowDays}d`);
  console.log(`top: ${board.models.slice(0, 3).map((m) => `${m.id}(${((m.heat.promptTokens + m.heat.completionTokens) / 1e12).toFixed(1)}T)`).join(', ')}`);

  const outPath = new URL('../src/data/paid-models.json', import.meta.url);
  // 噪声抑制：除 syncedAt 外无变化则不写盘（与 sync-free-models 同策略）
  let changed = true;
  try {
    const old = JSON.parse(readFileSync(outPath, 'utf8'));
    const { syncedAt: _o, ...oldRest } = old;
    const { syncedAt: _n, ...newRest } = board;
    if (JSON.stringify(oldRest) === JSON.stringify(newRest)) changed = false;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('could not diff old board:', err.message);
  }
  if (changed) {
    writeFileSync(new URL('../src/data/paid-models.json.tmp', import.meta.url), JSON.stringify(board, null, 2) + '\n');
    renameSync(new URL('../src/data/paid-models.json.tmp', import.meta.url), outPath);
    console.log('wrote src/data/paid-models.json');
  } else {
    console.log('paid board: no changes');
  }
}

if (process.argv[1] && process.argv[1].endsWith('sync-paid-models.mjs')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run scripts/sync-paid-models.test.mjs`
Expected: PASS（7 个用例全绿）

- [ ] **Step 5: 真实跑一次，生成首份数据**

Run: `node scripts/sync-paid-models.mjs`
Expected: `wrote src/data/paid-models.json`，stdout 的 top 3 与榜单合理（deepseek-v4.1-flash 应在第一）。抽查 `head -40 src/data/paid-models.json`。

- [ ] **Step 6: 提交**

```bash
git add scripts/sync-paid-models.mjs scripts/sync-paid-models.test.mjs src/data/paid-models.json
git commit -m "feat(data): sync paid popular models board from OpenRouter rankings

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 类型与格式化助手 `src/lib/paid-models.ts`（TDD）

**Files:**
- Create: `src/lib/paid-models.ts`
- Test: `src/lib/paid-models.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/paid-models.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { fmtTokens, fmtPrice } from './paid-models';

describe('fmtTokens', () => {
  it('formats T/B/M with one decimal, trimming .0', () => {
    expect(fmtTokens(1.25e12)).toBe('1.3T');
    expect(fmtTokens(940e9)).toBe('940B');
    expect(fmtTokens(12.5e6)).toBe('12.5M');
    expect(fmtTokens(900)).toBe('900');
  });
});

describe('fmtPrice', () => {
  it('renders $/1M with up to 3 significant digits', () => {
    expect(fmtPrice(2)).toBe('$2');
    expect(fmtPrice(0.14)).toBe('$0.14');
    expect(fmtPrice(0.125)).toBe('$0.125');
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run src/lib/paid-models.test.ts` → FAIL（模块不存在）

- [ ] **Step 3: 实现**

创建 `src/lib/paid-models.ts`：

```ts
// paid-models.json 的前端类型（scripts/sync-paid-models.mjs 生成）+ 展示格式化。
export interface PaidModel {
  id: string;
  name: string;
  canonicalSlug: string | null;
  heat: { promptTokens: number; completionTokens: number };
  /** $/1M tokens（脚本已从 $/token 换算，页面不再算价）。 */
  price: { input: number; output: number };
  context: number;
  maxOutput: number | null;
  toolCall: boolean;
  reasoning: boolean;
  attachment: boolean;
  detailUrl: string;
}

export interface PaidBoard {
  syncedAt: string;
  source: string;
  windowDays: number;
  totalCandidates: number;
  models: PaidModel[];
}

export function fmtTokens(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1).replace(/\.0$/, '')}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  return String(Math.round(n));
}

export function fmtPrice(n: number): string {
  return `$${Number(n.toPrecision(3)).toString()}`;
}
```

- [ ] **Step 4: 确认通过 + 提交**

Run: `npx vitest run src/lib/paid-models.test.ts` → PASS

```bash
git add src/lib/paid-models.ts src/lib/paid-models.test.ts
git commit -m "feat(lib): types and formatters for the paid models board

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 页面 `/paid-models` + 导航

**Files:**
- Create: `src/pages/paid-models.astro`
- Modify: `src/layouts/BaseLayout.astro`（nav 数组，约 37 行）
- Modify: `src/pages/index.astro`（tools 数组首项后插入，约 8 行）

- [ ] **Step 1: 创建页面**

创建 `src/pages/paid-models.astro`：

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
import SyncBadge from '../components/SyncBadge.astro';
import data from '../data/paid-models.json';
import type { PaidBoard } from '../lib/paid-models';
import { fmtTokens, fmtPrice } from '../lib/paid-models';
const idx = data as PaidBoard;
const BASE_URL = import.meta.env.BASE_URL.replace(/\/?$/, '/');

const caps = (m: { toolCall: boolean; reasoning: boolean; attachment: boolean }) =>
  [m.toolCall && 'tools', m.reasoning && 'reasoning', m.attachment && 'vision'].filter(Boolean) as string[];

const fmtCtx = (n: number) =>
  n >= 1e6 ? `${(n / 1048576).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${Math.round(n / 1024)}K` : String(n);

const chatHref = (m: { id: string; name: string; context: number; maxOutput: number | null }) => {
  const qs = new URLSearchParams({ chat: 'openrouter', model: m.id, name: m.name, ctx: String(m.context) });
  if (m.maxOutput) qs.set('maxout', String(m.maxOutput));
  return `${BASE_URL}free-models/?${qs}`;
};
const cfgHref = (m: { id: string }) =>
  `${BASE_URL}free-models/?${new URLSearchParams({ configure: 'openrouter', model: m.id })}`;

// 排序键 ↔ tr data 属性：值都是数字，JS 端不再解析
const heatOf = (m: { heat: { promptTokens: number; completionTokens: number } }) => m.heat.promptTokens + m.heat.completionTokens;
---
<BaseLayout
  title="Trending Paid LLM Models — Ranked by Weekly OpenRouter Usage"
  description={`The most-used paid LLMs on OpenRouter by weekly token volume, with per-million-token prices, context windows and capabilities. Synced daily.`}
>
  <h1>Trending paid LLM models</h1>
  <SyncBadge date={idx.syncedAt} detail="auto-synced daily from OpenRouter" />
  <p>
    The {idx.models.length} most-used paid models on OpenRouter over the last {idx.windowDays} days,
    ranked by token volume ({idx.totalCandidates} paid models have usage data). Click a column header to re-sort.
  </p>
  <p class="muted-note">
    Usage = OpenRouter weekly prompt+completion tokens. Prices are OpenRouter aggregate rates
    per 1M tokens (input/output) — not the vendors' direct-list prices.
  </p>

  <div class="tablewrap">
    <table>
      <thead><tr>
        <th scope="col">#</th>
        <th scope="col" class="sortable" data-key="heat" aria-sort="descending">Weekly usage</th>
        <th scope="col">Model</th>
        <th scope="col" class="sortable" data-key="in" aria-sort="none">In $/M</th>
        <th scope="col" class="sortable" data-key="out" aria-sort="none">Out $/M</th>
        <th scope="col" class="sortable" data-key="ctx" aria-sort="none">Context</th>
        <th scope="col">Capabilities</th>
        <th scope="col">Config</th>
      </tr></thead>
      <tbody>
        {idx.models.map((m, i) => (
          <tr data-heat={heatOf(m)} data-in={m.price.input} data-out={m.price.output} data-ctx={m.context}>
            <td class="num rank">{i + 1}</td>
            <td class="num">{fmtTokens(heatOf(m))}</td>
            <td class="col-model">
              <a href={m.detailUrl} target="_blank" rel="noopener" title="OpenRouter model page">{m.name}</a>
              <code class="model-id">{m.id}</code>
            </td>
            <td class="num">{fmtPrice(m.price.input)}</td>
            <td class="num">{fmtPrice(m.price.output)}</td>
            <td class="num">{fmtCtx(m.context)}</td>
            <td>{caps(m).length ? caps(m).join(' · ') : '—'}</td>
            <td class="col-config">
              <a class="btn" href={cfgHref(m)}>Configure</a>
              <a class="btn" href={chatHref(m)}>Chat</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>

  <p class="muted-note">
    Chat and Configure jump to the free-models page and open the same drawers there — bring your
    own OpenRouter key.
  </p>
</BaseLayout>

<style>
  .tablewrap { overflow-x: auto; }
  .tablewrap table { table-layout: fixed; min-width: 860px; border-collapse: collapse; width: 100%; }
  th, td { padding: .5rem .6rem; text-align: left; border-bottom: 1px solid rgba(127,127,127,0.18); font-size: .92rem; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--cobalt); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.rank { color: var(--ink-soft); }
  td.col-model { overflow-wrap: anywhere; }
  .model-id { display: block; font-size: .72rem; color: var(--ink-soft); }
  td.col-config { white-space: nowrap; }
  .btn { font: inherit; font-size: .85rem; padding: .3rem .65rem; margin-right: .3rem;
    border: 1px solid color-mix(in srgb, var(--ink) 25%, transparent); border-radius: 8px;
    background: none; color: var(--ink); text-decoration: none; cursor: pointer; }
  .btn:hover { background: var(--cobalt-wash); border-color: var(--cobalt); }
</style>

<script>
  // 列排序：默认热度降序（服务端已排好），点表头切换键/方向。行内 # 是热度名次，
  // 换排序键后保留——它标注的是"热度榜里的第几"，不是当前视图的第几。
  type Key = 'heat' | 'in' | 'out' | 'ctx';
  const tbody = document.querySelector('table tbody')!;
  const heads = Array.from(document.querySelectorAll<HTMLTableCellElement>('th.sortable'));
  let key: Key = 'heat';
  let desc = true;
  const rows = () => Array.from(tbody.querySelectorAll<HTMLTableRowElement>('tr'));
  function render() {
    rows()
      .sort((a, b) => desc
        ? Number(b.dataset[key]) - Number(a.dataset[key])
        : Number(a.dataset[key]) - Number(b.dataset[key]))
      .forEach((tr) => tbody.append(tr));
    for (const th of heads) {
      th.setAttribute('aria-sort', th.dataset.key === key ? (desc ? 'descending' : 'ascending') : 'none');
    }
  }
  for (const th of heads) {
    th.addEventListener('click', () => {
      const k = th.dataset.key as Key;
      if (k === key) desc = !desc; else { key = k; desc = true; }
      render();
    });
  }
</script>
```

- [ ] **Step 2: 加导航**

`src/layouts/BaseLayout.astro` nav 数组（约 37 行），在 Free Models 后插入：

```astro
          { href: BASE_URL + 'free-models/', label: 'Free Models' },
          { href: BASE_URL + 'paid-models/', label: 'Paid Models' },
```

`src/pages/index.astro`：顶部加 `import paidIdx from '../data/paid-models.json';`，tools 数组在 free-models 卡片后插入：

```astro
  { href: BASE_URL + 'free-models/', name: 'Free model directory', desc: `Every $0-per-token model across ${freeIdx.providers.length} providers, synced daily — with one-click config for Claude Code and Codex.`, tag: 'Free' },
  { href: BASE_URL + 'paid-models/', name: 'Trending paid models', desc: `The ${paidIdx.models.length} most-used paid LLMs on OpenRouter by weekly token volume, priced per 1M tokens.`, tag: 'Trending' },
```

- [ ] **Step 3: 验证**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: 全部通过；`dist/paid-models/index.html` 存在且含 "Trending paid LLM models"。

Run: `npx astro dev --background && sleep 3 && curl -s http://localhost:4321/paid-models/ | grep -c "Trending paid"`
Expected: ≥1（dev 起来后）。看完 `npx astro dev stop`。

- [ ] **Step 4: 提交**

```bash
git add src/pages/paid-models.astro src/layouts/BaseLayout.astro src/pages/index.astro
git commit -m "feat(site): /paid-models board ranked by weekly OpenRouter usage

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 跨页链接（query → 免费页抽屉）

**Files:**
- Create: `src/lib/chatlink.ts`
- Test: `src/lib/chatlink.test.ts`
- Modify: `src/pages/free-models.astro`（import 行 ~323、openConfig ~382、脚本末尾接线）

- [ ] **Step 1: 写失败测试**

创建 `src/lib/chatlink.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { parseOpenChatParams, parseOpenConfigParams } from './chatlink';

describe('parseOpenChatParams', () => {
  it('parses chat/model/name/ctx/maxout', () => {
    expect(parseOpenChatParams('?chat=openrouter&model=z-ai/glm-5.3&name=GLM&ctx=131072&maxout=65536'))
      .toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.3', name: 'GLM', ctx: 131072, maxout: 65536 });
  });
  it('defaults ctx/maxout to 0 and name to undefined when absent', () => {
    expect(parseOpenChatParams('?chat=openrouter&model=m'))
      .toEqual({ provider: 'openrouter', model: 'm', name: undefined, ctx: 0, maxout: 0 });
  });
  it('returns null without chat or model', () => {
    expect(parseOpenChatParams('?chat=openrouter')).toBeNull();
    expect(parseOpenChatParams('?model=m')).toBeNull();
    expect(parseOpenChatParams('')).toBeNull();
  });
  it('treats non-numeric ctx/maxout as 0 instead of NaN', () => {
    expect(parseOpenChatParams('?chat=openrouter&model=m&ctx=abc&maxout=')).ctx.toBe(0);
  });
});

describe('parseOpenConfigParams', () => {
  it('parses configure/model/name', () => {
    expect(parseOpenConfigParams('?configure=openrouter&model=m&name=M'))
      .toEqual({ provider: 'openrouter', model: 'm', name: 'M' });
  });
  it('returns null without configure or model', () => {
    expect(parseOpenConfigParams('?configure=openrouter')).toBeNull();
    expect(parseOpenConfigParams('')).toBeNull();
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run src/lib/chatlink.test.ts` → FAIL（模块不存在）

- [ ] **Step 3: 实现**

创建 `src/lib/chatlink.ts`：

```ts
// /paid-models 的 Chat/Configure 按钮是跨页链接：免费页加载时解析 query 调已有
// openChat()/openConfig()（抽屉只此一份，不复制）。解析提成纯函数供单测——
// .astro 内联脚本 vitest import 不到，与 agentchat.ts 同一模式。
export interface OpenChatParams {
  provider: string; model: string; name?: string; ctx: number; maxout: number;
}

export function parseOpenChatParams(search: string): OpenChatParams | null {
  const q = new URLSearchParams(search);
  const provider = q.get('chat');
  const model = q.get('model');
  if (!provider || !model) return null;
  const num = (v: string | null) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : 0);
  return { provider, model, name: q.get('name') ?? undefined, ctx: num(q.get('ctx')), maxout: num(q.get('maxout')) };
}

export interface OpenConfigParams { provider: string; model: string; name?: string }

export function parseOpenConfigParams(search: string): OpenConfigParams | null {
  const q = new URLSearchParams(search);
  const provider = q.get('configure');
  const model = q.get('model');
  if (!provider || !model) return null;
  return { provider, model, name: q.get('name') ?? undefined };
}
```

- [ ] **Step 4: 确认通过**

Run: `npx vitest run src/lib/chatlink.test.ts` → PASS

- [ ] **Step 5: 免费页接线（free-models.astro 三处修改）**

5a. import 行（~323）追加：

```ts
  import { parseOpenChatParams, parseOpenConfigParams } from '../lib/chatlink';
```

5b. `openConfig`（~382）在 `fillModels();` 之后、`modelSel.value = model;` 之前插入付费模型 option 兜底：

```ts
  function openConfig(provider: string, model: string, label: string): void {
    provSel.value = provider;
    fillModels();
    // 跨页链接进来的模型（/paid-models）不在 free-models.json 里，select 没有
    // 对应 option 时直接赋 value 会静默失败停在第一项——追加一个再选中。
    if (model && !Array.from(modelSel.options).some((o) => o.value === model)) {
      const o = document.createElement('option');
      o.value = model;
      o.textContent = label || model;
      modelSel.append(o);
    }
    modelSel.value = model;
```

（其余行保持不变。）

5c. 脚本末尾（chat-pick 接线块之后）加 URL 参数处理器：

```ts
  // ── 跨页打开（/paid-models 的按钮）：URL query → 已有抽屉路径 ──────────
  // provider 元数据（base/anthropic/envKey）从 idx.providers 查，不在 URL 里
  // 重复携带。未知 provider 静默忽略——免费页自身行为零变化。
  (() => {
    const open = parseOpenChatParams(location.search);
    const cfg = open ? null : parseOpenConfigParams(location.search);
    if (open) {
      const p = idx.providers.find((x) => x.id === open.provider);
      if (!p) return;
      const el = document.createElement('div');
      el.dataset.provider = open.provider;
      el.dataset.model = open.model;
      el.dataset.base = p.api ?? '';
      el.dataset.anthropic = p.anthropicApi ?? '';
      el.dataset.envkey = p.envKey;
      el.dataset.ctx = String(open.ctx);
      el.dataset.maxout = String(open.maxout);
      el.dataset.name = open.name ?? open.model;
      el.dataset.agents = 'pi'; // 付费 openrouter 模型不在 :free gate 范围
      currentPickEl = el;
      openChat(el);
    } else if (cfg && idx.providers.some((x) => x.id === cfg.provider)) {
      openConfig(cfg.provider, cfg.model, cfg.name ?? cfg.model);
    }
  })();
```

- [ ] **Step 6: 验证 + 提交**

Run: `npx tsc --noEmit && npx vitest run` → 全绿
人工核：`npx astro dev --background`，开 `http://localhost:4321/free-models/?chat=openrouter&model=z-ai/glm-5.3&name=GLM&ctx=131072` 应直接弹 Chat 抽屉且模型名正确；`?configure=openrouter&model=z-ai/glm-5.3` 应弹配置抽屉且 Model 下拉选中该 id。看完 `npx astro dev stop`。

```bash
git add src/lib/chatlink.ts src/lib/chatlink.test.ts src/pages/free-models.astro
git commit -m "feat(chat): open chat/config drawers from cross-page links

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 每日同步工作流 + 全量验证 + 上线核对

**Files:**
- Modify: `.github/workflows/sync-models.yml`

- [ ] **Step 1: 工作流接入**

`.github/workflows/sync-models.yml` 的 steps 中，在 `node scripts/sync-free-models.mjs` 后加一行，`git add` 列表加新文件：

```yaml
      - run: node scripts/sync-free-models.mjs
      - run: node scripts/sync-paid-models.mjs
      - name: Commit if changed
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add src/data/free-models.json src/data/pricing.json src/data/paid-models.json
```

- [ ] **Step 2: 全量验证**

Run: `npm test && npx tsc --noEmit && cd packages/agent-server && npm test`
Expected: vitest 全绿（含两个新测试文件）、tsc 无错、网关 331+ 全绿。

- [ ] **Step 3: 提交并推送**

```bash
git add .github/workflows/sync-models.yml
git commit -m "ci: sync the paid models board in the daily models workflow

Co-Authored-By: Claude Code <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 4: 上线核对（产物级，不是 DOM 级）**

`gh run watch` 等 Deploy 工作流 success，然后：

Run: `curl -s https://dengzhh.github.io/agent-site/paid-models/ | grep -c "Trending paid LLM models"` → ≥1；
Run: `curl -s https://dengzhh.github.io/agent-site/ -o - | grep -c "paid-models"` → ≥1（首页卡片 + 导航链接）。

线上人工验收：打开线上 `/paid-models/`，点 In $/M 表头排序生效；点 Chat 跳到免费页并弹出抽屉。
