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
  it('differentiates model families', () => {
    expect(estimateTokens('x'.repeat(40), 'gpt')).toBeLessThan(estimateTokens('x'.repeat(40), 'claude'));
  });
  it('pins the exact formula', () => {
    expect(estimateTokens('你好a', 'gpt')).toBe(3);
  });
});
