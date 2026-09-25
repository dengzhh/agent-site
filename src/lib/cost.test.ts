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
  it('cacheReadPct above 1 clamps to full cache-read price', () => {
    const r = monthlyCost(opus55, { inputTokens: 1_000_000, outputTokens: 0, requestsPerMonth: 1, cacheReadPct: 1.5 });
    expect(r).toBeCloseTo(0.20, 6);
  });
  it('negative cacheReadPct clamps to full input price', () => {
    const r = monthlyCost(opus55, { inputTokens: 1_000_000, outputTokens: 0, requestsPerMonth: 1, cacheReadPct: -0.2 });
    expect(r).toBeCloseTo(4.0, 6);
  });
  it('negative requests clamps cost to zero', () => {
    const r = monthlyCost(opus55, { inputTokens: 10_000, outputTokens: 2_000, requestsPerMonth: -100 });
    expect(r).toBe(0);
  });
});
