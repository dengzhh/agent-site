// ACP `session/update` 通知 → 网关事件。纯函数，便于单测。
// 未识别的 update 类型一律忽略（协议会演进；未知类型不该打断会话）。
export function mapSessionUpdate(params) {
  const u = params?.update;
  if (!u || typeof u !== 'object') return [];
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = u.content?.text;
      return typeof text === 'string' && text ? [{ type: 'delta', text }] : [];
    }
    case 'agent_thought_chunk': {
      const text = u.content?.text;
      return typeof text === 'string' && text ? [{ type: 'thinking', text }] : [];
    }
    case 'usage_update':
      // 真实 ACP 形状：{used, size, cost?}（上下文窗口用量）。
      // 注意：不是 {inputTokens, outputTokens}——那是 hermes 的私有扩展，非协议标准。
      return [{ type: 'usage', usage: { used: u.used, size: u.size, cost: u.cost } }];
    case 'tool_call':
      return [{ type: 'activity', title: u.title ?? u.name ?? u.kind ?? 'tool call' }];
    default:
      return [];
  }
}
