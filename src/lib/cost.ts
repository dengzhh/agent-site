export interface ModelPricing {
  id: string;
  label: string;
  contextWindow: number;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
}

export interface CostInput {
  /**
   * Token/request counts are expected to be finite non-negative numbers;
   * cache-write premium is out of scope for this model.
   */
  inputTokens: number;
  outputTokens: number;
  requestsPerMonth: number;
  cacheReadPct?: number; // 0–1
}

export function monthlyCost(m: ModelPricing, usage: CostInput): number {
  const cachePct = Math.min(Math.max(usage.cacheReadPct ?? 0, 0), 1);
  const effInput = m.cacheReadPerMTok != null
    ? m.inputPerMTok * (1 - cachePct) + m.cacheReadPerMTok * cachePct
    : m.inputPerMTok;
  const perRequest = (usage.inputTokens / 1e6) * effInput + (usage.outputTokens / 1e6) * m.outputPerMTok;
  return Math.max(0, perRequest * usage.requestsPerMonth);
}
