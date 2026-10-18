// Claude Code `--output-format=stream-json` 的逐行解析。
// 提取三类行：文本增量（stream_event/content_block_delta/text_delta）、
// 终结行（result）、以及 full 级别权限转发的控制帧（control_request/can_use_tool）。
// assistant 整块消息行刻意忽略——其文本已由 delta 覆盖，
// 重复消费会让前端出现双份文字。
export function parseCcLine(line) {
  if (!line) return null;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  // JSON 合法但非对象（null / 数字 / 字符串 / 布尔）同样视为无关行；
  // 缺此守卫时输入 "null" 会在读 obj.type 时抛 TypeError。
  if (typeof obj !== 'object' || obj === null) return null;

  // ── stream-json 双向控制通道（full 级别，Task 11）────────────────────────────
  // `--permission-prompt-tool stdio` 把权限提示路由到父进程：stdout 发
  // control_request(subtype=can_use_tool)，stdin 期待 control_response。
  // 帧形状对齐官方 SDK（@anthropic-ai/claude-agent-sdk 的 canUseTool 路径）：
  //   request : {type:'control_request', request_id, request:{subtype:'can_use_tool',
  //             tool_name, input, tool_use_id, permission_suggestions, ...}}
  //   response: {type:'control_response', response:{subtype:'success', request_id,
  //             response:{behavior:'allow',updatedInput}|{behavior:'deny',message}, toolUseID}}
  if (obj.type === 'control_request' && obj.request?.subtype === 'can_use_tool' && typeof obj.request_id === 'string') {
    return {
      type: 'control_request',
      requestId: obj.request_id,
      toolName: String(obj.request.tool_name ?? ''),
      input: obj.request.input && typeof obj.request.input === 'object' ? obj.request.input : {},
      toolUseId: typeof obj.request.tool_use_id === 'string' ? obj.request.tool_use_id : null,
    };
  }
  // control_cancel_request 与其他子类型（hook_callback / mcp_message / …）不消费：
  // CLI 对迟到或多余的 control_response 有容错路径（"Ignoring duplicate …"）。
  if (obj.type === 'control_request' || obj.type === 'control_cancel_request') return null;

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

// ── full 级别权限转发（Task 11）──────────────────────────────────────────────

// 把工具调用入参压缩成权限卡上的人类可读摘要。字段优先级对齐 CC 内置工具
// （Bash.command、Write/Edit/Read.file_path、WebFetch.url、Grep.pattern…），
// 无已知字段时回退紧凑 JSON。超长截断——摘要进 SSE 帧与抽屉 UI，不进日志存档。
const SUMMARY_MAX = 160;

export function summarizeToolInput(toolName, input) {
  const inp = input && typeof input === 'object' ? input : {};
  const focus = [inp.command, inp.file_path, inp.path, inp.notebook_path, inp.url, inp.pattern, inp.query]
    .find((v) => typeof v === 'string' && v.length > 0);
  const raw = typeof focus === 'string'
    ? `${toolName} ${focus}`
    : `${toolName} ${JSON.stringify(inp)}`;
  return raw.length > SUMMARY_MAX ? `${raw.slice(0, SUMMARY_MAX - 3)}...` : raw;
}

// 构造回写 CC 的 control_response 帧（见 parseCcLine 处的形状注释）。
// allow 带 updatedInput（照原样放行该次调用）；deny 必须带 message。
// toolUseID 已知时按 SDK 的驼峰命名放进取值对象内，未知则整个省略。
export function buildControlResponse(requestId, { allow, input, message, toolUseId = null } = {}) {
  const response = allow
    ? { behavior: 'allow', updatedInput: input ?? {} }
    : { behavior: 'deny', message: message ?? 'denied by user' };
  if (toolUseId) response.toolUseID = toolUseId;
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}
