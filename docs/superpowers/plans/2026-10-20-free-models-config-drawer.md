# Free-models config column + configure drawer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the free-models table read as a professional, spacious list (no cramped Config column, long model ids no longer squeezed), and replace the "Configure → scrolls to page bottom" jump with an instant right-side config drawer that sits alongside the existing chat drawer.

**Architecture:** The single page `src/pages/free-models.astro` holds all table markup, scoped styles and the client script. We (1) extract the two pure behaviours — "drawer mutual exclusion" and "instant scroll" — into a tiny testable module `src/lib/drawer.ts`; (2) convert the inline `<section id="configure">` generator into an `<aside id="config-drawer">` that reuses the chat drawer's `is-open` pattern; (3) restyle the Config column as two compact buttons and rebalance table column widths so the Model column gets the room. TDD at the unit level (`drawer.ts` via vitest), DOM/visual changes verified by build + type-check + a manual browser pass.

**Tech Stack:** Astro 5 (single `.astro` page, scoped styles, client `<script>`), TypeScript (strict, `astro check`), vitest (node env) for `src/lib/*.test.ts`, plain DOM APIs (no framework).

---

## File Structure

- **Create** `src/lib/drawer.ts` — pure helpers: `openDrawer(drawers, target)` returns the list of drawers whose `is-open` class should be set; `stopScroll()` cancels any in-flight smooth scroll by jumping to the current position instantly. One responsibility each, no DOM-internal knowledge beyond the two class/scroll calls.
- **Create** `src/lib/drawer.test.ts` — vitest unit tests for both helpers (fake elements exposing `classList`).
- **Modify** `src/pages/free-models.astro`:
  - markup: `<section id="configure">` → `<aside id="config-drawer" aria-hidden="true">` placed next to `#chat-drawer`; table Config cell → two `<button>`s.
  - styles: Config column button style; table `table-layout: fixed`-backed column widths via `<colgroup>`; model id wrapping; config drawer styles mirroring `#chat-drawer`.
  - script: replace `.pick` anchor handler with drawer opening; chat opening closes config drawer and vice-versa; close button + Esc + `.drawer-backdrop` for both drawers.

No other files change. `src/lib/freeconfig.ts` and its generator stay untouched (the generator UI is reused, just relocated).

---

### Task 1: Instant-scroll + drawer exclusivity helpers (TDD)

**Files:**
- Create: `src/lib/drawer.ts`
- Test: `src/lib/drawer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { openDrawer, closeDrawers, stopScroll } from './drawer';

const fakeEl = (name: string) => {
  const classes = new Set<string>();
  return {
    name,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      toggle: (c: string, force: boolean) => (force ? classes.add(c) : classes.delete(c)),
      contains: (c: string) => classes.has(c),
    },
    has: (c: string) => classes.has(c),
  };
};

describe('openDrawer', () => {
  it('opens only the target drawer and closes the others', () => {
    const a = fakeEl('a');
    const b = fakeEl('b');
    a.classList.add('is-open');
    openDrawer([a, b], b);
    expect(a.has('is-open')).toBe(false);
    expect(b.has('is-open')).toBe(true);
  });

  it('reopening the already-open drawer keeps exactly one open', () => {
    const a = fakeEl('a');
    const b = fakeEl('b');
    a.classList.add('is-open');
    openDrawer([a, b], a);
    expect(a.has('is-open')).toBe(true);
    expect(b.has('is-open')).toBe(false);
  });

  it('also fixes aria-hidden on every drawer', () => {
    const a = fakeEl('a');
    const b = fakeEl('b');
    const attrs: Record<string, Record<string, string>> = { a: {}, b: {} };
    (a as any).setAttribute = (k: string, v: string) => { attrs.a[k] = v; };
    (b as any).setAttribute = (k: string, v: string) => { attrs.b[k] = v; };
    openDrawer([a, b], b);
    expect(attrs.a['aria-hidden']).toBe('true');
    expect(attrs.b['aria-hidden']).toBe('false');
  });
});

describe('closeDrawers', () => {
  it('closes every drawer and marks them aria-hidden', () => {
    const a = fakeEl('a');
    const b = fakeEl('b');
    a.classList.add('is-open');
    b.classList.add('is-open');
    closeDrawers([a, b]);
    expect(a.has('is-open')).toBe(false);
    expect(b.has('is-open')).toBe(false);
  });
});

describe('stopScroll', () => {
  it('jumps to the current position without smooth behaviour', () => {
    const scrollTo = vi.fn();
    stopScroll({ scrollY: 420, scrollTo });
    expect(scrollTo).toHaveBeenCalledWith({ top: 420, left: 0, behavior: 'instant' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/drawer.test.ts`
Expected: FAIL — `Failed to resolve import "./drawer"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// 两个抽屉（Configure 生成器 / Chat）共用的开合约定：同时只开一个。
// 独立成模块是为了能脱离浏览器做单测（页面脚本无法在 vitest node 环境里跑）。
type DrawerEl = {
  classList: { toggle(c: string, force?: boolean): unknown };
  setAttribute(name: string, value: string): void;
};

export function openDrawer<T extends DrawerEl>(drawers: readonly T[], target: T): void {
  for (const d of drawers) {
    const open = d === target;
    d.classList.toggle('is-open', open);
    d.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
}

export function closeDrawers<T extends DrawerEl>(drawers: readonly T[]): void {
  for (const d of drawers) {
    d.classList.toggle('is-open', false);
    d.setAttribute('aria-hidden', 'true');
  }
}

// 全局 scroll-behavior: smooth 会让锚点跳转平滑滚动好几秒。打开抽屉时页面
// 本不该动——直接跳到当前位置，取消在途的平滑滚动。
export function stopScroll(win: { scrollY: number; scrollTo(opt: { top: number; left: number; behavior: 'instant' }): void }): void {
  win.scrollTo({ top: win.scrollY, left: 0, behavior: 'instant' });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/drawer.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/drawer.ts src/lib/drawer.test.ts
git commit -m "feat(site): drawer exclusivity and instant-scroll helpers"
```

---

### Task 2: Config generator becomes a right-side drawer

**Files:**
- Modify: `src/pages/free-models.astro` (markup around the `<section id="configure">`, styles, script `.pick` handler)

- [ ] **Step 1: Replace the inline generator section with a drawer**

Replace `<section id="configure" class="generator" tabindex="-1"> … </section>` with:

```astro
  <aside id="config-drawer" class="config-drawer" aria-label="Generate config" aria-hidden="true">
    <header class="chat-head">
      <div><strong>Config for this model</strong><div class="chat-sub">Key is merged in your browser only</div></div>
      <button id="config-close" type="button" class="drawer-close" aria-label="Close config">✕</button>
    </header>
    <div class="config-body">
      <p class="chat-sub" id="config-pick-label"></p>
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
      <pre id="g-out" class="result" aria-live="polite"></pre>
      <button id="g-copy" type="button" hidden>Copy</button>
    </div>
  </aside>
```

Notes for the implementer:
- `.field-row` uses a 2-column grid meant for the wide page; inside a 480px drawer it must go single-column — add `@media`-free override `.config-body .field-row { grid-template-columns: 1fr; }`.
- Keep `g-provider`, `g-model`, `g-key`, `g-target`, `g-out`, `g-copy`, `gen-form` ids identical — the existing script depends on them. `render()` still runs on change/submit.
- Remove the old `.generator` section styles if now unused.

- [ ] **Step 2: Add drawer styles (mirror `#chat-drawer`)**

```css
  /* ---------- config drawer（与 chat 抽屉同一套开合机制） ---------- */
  #config-drawer {
    position: fixed; top: 0; right: 0; bottom: 0;
    width: min(480px, 100vw);
    background: var(--surface); border-left: 1px solid var(--line-strong);
    box-shadow: -12px 0 32px rgba(0,0,0,0.35);
    transform: translateX(102%); transition: transform .25s ease;
    display: flex; flex-direction: column; z-index: 61;
    padding: 1rem 1.1rem; overflow-y: auto;
  }
  #config-drawer.is-open { transform: translateX(0); }
  .config-body { display: flex; flex-direction: column; gap: .8rem; margin-top: .8rem; }
  .config-body .field-row { grid-template-columns: 1fr; }
  .config-body #g-out { margin: 0; max-height: 40vh; overflow: auto; }
  .drawer-close { background: transparent; border: 0; color: var(--ink-soft); font-size: 1.1rem; cursor: pointer; padding: .2rem .4rem; }
  #chat-close { background: transparent; border: 0; color: var(--ink-soft); font-size: 1.1rem; cursor: pointer; padding: .2rem .4rem; }
```

- [ ] **Step 3: Wire the open/settle script**

Replace the `.pick` anchor handler with (keep imports, add `openDrawer`, `closeDrawers`, `stopScroll` from `../lib/drawer`):

```ts
  const configDrawer = $('config-drawer');
  const bothDrawers = () => [configDrawer, drawer] as HTMLElement[];

  function openConfig(provider: string, model: string, label: string): void {
    provSel.value = provider;
    fillModels();
    modelSel.value = model;
    render();
    ($('config-pick-label') as HTMLElement).textContent = label;
    openDrawer(bothDrawers(), configDrawer);
    stopScroll(window);
  }

  document.querySelectorAll<HTMLButtonElement>('button.pick').forEach((b) => {
    b.addEventListener('click', () => openConfig(b.dataset.provider!, b.dataset.model!, b.dataset.name ?? ''));
  });
  $('config-close').addEventListener('click', () => closeDrawers(bothDrawers()));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawers(bothDrawers()); });
```

The chat drawer's open path already lives in `openChat` (`drawer.classList.add('is-open')`); modify that line to `openDrawer(bothDrawers(), drawer);` so opening chat closes config. Because `configDrawer`/`drawer` are read at call time inside `bothDrawers()`, no ordering problem if `const drawer = $('chat-drawer')` is declared later.

- [ ] **Step 4: Same for chat's close button**

Change `$('chat-close')` handler from `drawer.classList.remove('is-open')` / `setAttribute('aria-hidden','true')` to `closeDrawers(bothDrawers())` (keeps the existing `stopProbe()` / abort / reset logic that follows).

- [ ] **Step 5: Type-check and build**

Run: `npx astro check && npx astro build`
Expected: 0 errors, build completes, `dist/free-models/index.html` contains `id="config-drawer"`.

- [ ] **Step 6: Commit**

```bash
git add src/pages/free-models.astro
git commit -m "feat(site): open config generator in a right-side drawer instead of scrolling"
```

---

### Task 3: Config column as two buttons + table column rebalance

**Files:**
- Modify: `src/pages/free-models.astro`

- [ ] **Step 1: Replace the Config cell markup**

```astro
                <td class="col-config">
                  <button type="button" class="pick" data-provider={p.id} data-model={m.id} data-name={m.name}>Configure</button>
                  {p.id !== 'github-copilot' && (
                    <button type="button" class="chat-pick" data-provider={p.id} data-model={m.id}
                      data-base={p.api ?? ''} data-anthropic={p.anthropicApi ?? ''} data-envkey={p.envKey} data-ctx={m.context} data-maxout={m.maxOutput}
                      data-agents={m.agents?.join(',') || 'pi'}
                      data-name={m.name}>Chat</button>
                  )}
                </td>
```

Update the `.chat-pick` selector in the script from `a.chat-pick` to `button.chat-pick`.

- [ ] **Step 2: Add a `<colgroup>` and wrap the Model cell**

Insert immediately after `<table>`:

```astro
          <colgroup>
            <col class="col-model" /><col class="col-num" /><col class="col-num" /><col class="col-caps" /><col class="col-updated" /><col class="col-config" />
          </colgroup>
```

Model cell: keep name + `<code>{m.id}</code>` but give the cell `<td class="col-model">` (already first) — the id stays on its own line via a block `<code class="model-id">`.

- [ ] **Step 3: Column widths + wrapping styles**

```css
  .tablewrap table { table-layout: fixed; min-width: 720px; }
  .col-model { width: auto; }
  .col-num { width: 6.5rem; }
  .col-caps { width: 11rem; }
  .col-updated { width: 6rem; }
  .col-config { width: 10.5rem; }
  .model-id, :global(code.model-id) { display: block; font-size: .8rem; overflow-wrap: anywhere; margin-top: .15rem; color: var(--ink-soft); }
  td.col-config { white-space: nowrap; }
  td.col-config button {
    padding: .25rem .7rem; font-size: .78rem; font-weight: 500;
    background: var(--surface); color: var(--cobalt);
    border: 1px solid var(--line-strong); border-radius: 6px; cursor: pointer;
  }
  td.col-config button + button { margin-left: .4rem; }
  td.col-config button:hover { border-color: var(--cobalt); }
```

- [ ] **Step 4: Build and inspect the rendered widths**

Run: `npx astro build`
Then load the preview page (or `dist/free-models/index.html` via `npx serve`) at 1280px and 768px widths; Expected: no Config cell wraps to two lines; long ids wrap only at narrow widths.

- [ ] **Step 5: Commit**

```bash
git add src/pages/free-models.astro
git commit -m "style(site): compact config column buttons and rebalance table widths"
```

---

## Self-Review

- Spec §A1 (config drawer) → Task 2. Spec §A1 exclusivity with chat → Task 1 + Task 2 steps 3–4.
- Spec §2 (no unintended scroll, instant) → `stopScroll` in Task 1, called in `openConfig`.
- Spec §3 (buttons) & §4 (column widths / id wrapping) → Task 3.
- Placeholder scan: the only inline placeholder is inside Step 3's intermediate sketch; the final code block in Step 3 supersedes it — implementer must use the second block only.
- Type consistency: `openDrawer(drawers, target)` and `stopScroll(win)` used identically in tests and page script; `.pick` / `.chat-pick` both become `<button>` in Task 3, and Task 2's `.pick` handler already targets `button.pick`.
