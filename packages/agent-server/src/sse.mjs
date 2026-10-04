// SSE 帧：事件即一行 data: JSON。type 为 null 时输出注释心跳。
export function encodeSSE(type, payload) {
  if (type === null) return ': ping\n\n';
  return `data: ${JSON.stringify({ type, ...payload })}\n\n`;
}
