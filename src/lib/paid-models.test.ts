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
