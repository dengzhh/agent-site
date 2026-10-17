// 统一日志：时间戳 + 短标签，输出到 stdout/stderr。
// 纪律：绝不打印 apiKey / 完整请求体——只打预览与统计。
// ATBX_VERBOSE=1 时额外转发 agent 子进程的 stderr（排障用，平时噪声太大）。
const ts = () => new Date().toISOString().slice(11, 19);

export const VERBOSE = process.env.ATBX_VERBOSE === '1';

export function log(tag, msg) {
  console.log(`${ts()} [${tag}] ${msg}`);
}

export function logErr(tag, msg) {
  console.error(`${ts()} [${tag}] ${msg}`);
}

// 文本预览：截断 + 单行化（多行消息只留一行，避免日志被刷屏）
export function preview(text, max = 60) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}
