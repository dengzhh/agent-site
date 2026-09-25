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
