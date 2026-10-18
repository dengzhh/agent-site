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

// ── request_permission 转发（期 2，Task 12）──────────────────────────────────
// full 级别下权限询问经 ctx.requestApproval(action, summary) 转发抽屉。以下两个
// 纯函数负责「请求参数 → 抽屉文案 / 应答 optionId」的映射，便于单测。

// 摘要上限与 cc 的 summarizeToolInput（cc-stream.mjs）对齐：进 SSE 帧与抽屉 UI。
const SUMMARY_MAX = 160;

// toolCall → { action, summary }。
// action 优先取 kind——ACP 的 ToolKind（read/edit/delete/move/search/execute/
// think/fetch/switch_mode/other）正是 pi 的 'write'/'bash' 那一类语义类别，适合
// 抽屉上的动作标签；agent 未给 kind 时退回 title。summary 是 title + kind 的一句话
// 摘要（title 已含 kind 词时不重复），超长截断。
export function describePermission(toolCall) {
  const call = toolCall && typeof toolCall === 'object' ? toolCall : {};
  const title = String(call.title ?? call.name ?? '').trim();
  const kind = String(call.kind ?? '').trim();
  const action = kind || title || 'tool';
  const raw = !title ? (kind || 'tool')
    : !kind || title.toLowerCase().includes(kind.toLowerCase()) ? title
    : `${title} (${kind})`;
  return {
    action,
    summary: raw.length > SUMMARY_MAX ? `${raw.slice(0, SUMMARY_MAX - 3)}...` : raw,
  };
}

// 从请求自带的 options 里解析放行/拒绝各自的 optionId（optionId 命名各 agent 不
// 一致，只按 option.kind 语义解析；PermissionOptionKind 仅 allow_once/allow_always/
// reject_once/reject_always 四值）。决策表（fail-closed，命中不了返回 null，由
// 调用方应答 cancelled——schema 支持的「用户未选择」）：
//  - 只认 *_once：once = 每次都问。绝不替用户选 *_always（「允许并记住」会让后续
//    同类操作永久绕过询问抽屉），家族里只有 *_always 时按未选择处理。
//  - options 缺失/空、kind 缺失或违规（schema 必填，违规即不可信）→ null。
//  - 不做 name 关键词兜底：名字不可信（"Notify me and proceed" 含 "No"，曾会把
//    拒绝决策答到放行项上）。
export function resolveOutcomeOptionIds(options) {
  const list = Array.isArray(options) ? options : [];
  const idOf = (familyRe) => {
    const hit = list.find((o) => typeof o?.optionId === 'string' && o.optionId !== ''
      && familyRe.test(String(o?.kind ?? '')) && /_once$/.test(String(o?.kind ?? '')));
    return hit ? hit.optionId : null;
  };
  return { allowId: idOf(/^allow_/), rejectId: idOf(/^reject_/) };
}
