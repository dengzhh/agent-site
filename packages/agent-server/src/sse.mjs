// SSE 帧：事件即一行 data: JSON。type 为 null 时输出注释心跳。
export function encodeSSE(type, payload) {
  if (type === null) return ': ping\n\n';
  // type 放后面：调用方 payload 即使带 type 键也不会覆盖事件类型
  return `data: ${JSON.stringify({ ...payload, type })}\n\n`;
}
