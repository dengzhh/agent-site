import { describe, it, expect } from 'vitest';
import { buildPaidBoard } from './sync-paid-models.mjs';

// 合成 fixture：字段形状照真实接口，不联网。
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
