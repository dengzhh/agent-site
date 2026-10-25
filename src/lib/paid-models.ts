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
