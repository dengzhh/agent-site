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
  // <1e6 直接取整展示（榜单热度量级都在 B/T，这个兜底几乎不触发）
  if (n >= 1e12) return `${(n / 1e12).toFixed(1).replace(/\.0$/, '')}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  return String(Math.round(n));
}

export function fmtPrice(n: number): string {
  // 3 位有效数字 + 去尾零（0.500 → 0.5，2 → 2）：数据本身已是 3 位有效数字，这里只负责渲染
  return `$${Number(n.toPrecision(3)).toString()}`;
}
