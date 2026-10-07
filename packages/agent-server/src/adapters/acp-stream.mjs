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
      return u.usage ? [{ type: 'usage', usage: u.usage }] : [];
    case 'tool_call':
      return [{ type: 'activity', title: u.title ?? u.kind ?? 'tool call' }];
    default:
      return [];
  }
}
