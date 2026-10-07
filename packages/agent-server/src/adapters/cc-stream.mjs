// Claude Code `--output-format=stream-json` 的逐行解析。
// 只提取两类行：文本增量（stream_event/content_block_delta/text_delta）
// 与终结行（result）。assistant 整块消息行刻意忽略——其文本已由 delta 覆盖，
// 重复消费会让前端出现双份文字。
export function parseCcLine(line) {
  if (!line) return null;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  // JSON 合法但非对象（null / 数字 / 字符串 / 布尔）同样视为无关行；
  // 缺此守卫时输入 "null" 会在读 obj.type 时抛 TypeError。
  if (typeof obj !== 'object' || obj === null) return null;

  if (obj.type === 'stream_event') {
    const ev = obj.event;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
      return { type: 'delta', text: ev.delta.text };
    }
    return null;
  }

  if (obj.type === 'result') {
    const sessionId = obj.session_id ?? null;
    if (obj.is_error) {
      return { type: 'error', message: String(obj.result ?? 'Claude Code error'), sessionId };
    }
    return { type: 'turn_end', stopReason: obj.subtype === 'success' ? null : (obj.subtype ?? null), sessionId };
  }

  return null;
}

// OpenRouter 的 agentic-harness 网关拒绝信息（用于自动回退到 cc）
const GATE_PATTERN = /agentic harness/i;
export function isGateError(message) {
  return GATE_PATTERN.test(String(message ?? ''));
}
