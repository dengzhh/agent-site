export type ModelFamily = 'claude' | 'gpt' | 'gemini';

const CHARS_PER_TOKEN: Record<ModelFamily, number> = {
  claude: 3.6,
  gpt: 4.0,
  gemini: 4.0,
};

export function estimateTokens(text: string, family: ModelFamily): number {
  if (!text) return 0;
  const cjk = (text.match(/[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/gu) ?? []).length;
  const other = text.length - cjk;
  return Math.max(1, Math.ceil(cjk + other / CHARS_PER_TOKEN[family]));
}
