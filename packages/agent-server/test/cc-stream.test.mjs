import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCcLine, summarizeToolInput, buildControlResponse } from '../src/adapters/cc-stream.mjs';

test('text delta line becomes a delta event', () => {
  const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'PONG' } } });
  assert.deepEqual(parseCcLine(line), { type: 'delta', text: 'PONG' });
});

test('result line carries session id and error state', () => {
  const ok = JSON.stringify({ type: 'result', subtype: 'success', session_id: 'abc-123', is_error: false, result: 'PONG' });
  assert.deepEqual(parseCcLine(ok), { type: 'turn_end', stopReason: null, sessionId: 'abc-123' });
  const bad = JSON.stringify({ type: 'result', subtype: 'error_during_execution', session_id: 'abc-123', is_error: true, result: 'API Error: 403 ...' });
  assert.deepEqual(parseCcLine(bad), { type: 'error', message: 'API Error: 403 ...', sessionId: 'abc-123' });
});

test('ignores unrelated and malformed lines', () => {
  assert.equal(parseCcLine(JSON.stringify({ type: 'system', subtype: 'init' })), null);
  assert.equal(parseCcLine(JSON.stringify({ type: 'assistant', message: {} })), null);
  assert.equal(parseCcLine('not json'), null);
  assert.equal(parseCcLine(''), null);
  // JSON 合法但非对象：必须原样忽略而不是抛错（"null" 曾触发 TypeError）
  assert.equal(parseCcLine('null'), null);
  assert.equal(parseCcLine('123'), null);
});

test('assistant block lines do not enter the event stream', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 400 unavailable' }] } });
  assert.equal(parseCcLine(line), null); // assistant 行不进事件流，避免与 delta 重复
});

// ── stream-json 控制通道（full 级别权限转发，Task 11）───────────────────────────

test('can_use_tool control_request parses into a typed event', () => {
  const line = JSON.stringify({
    type: 'control_request',
    request_id: 'req-9',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu-7', permission_suggestions: [] },
  });
  assert.deepEqual(parseCcLine(line), {
    type: 'control_request',
    requestId: 'req-9',
    toolName: 'Bash',
    input: { command: 'ls' },
    toolUseId: 'tu-7',
  });
});

test('non-permission control frames are ignored, malformed input is hardened', () => {
  // 其他 control_request 子类型（hook_callback 等）与取消帧不进事件流
  assert.equal(parseCcLine(JSON.stringify({ type: 'control_request', request_id: 'r', request: { subtype: 'hook_callback' } })), null);
  assert.equal(parseCcLine(JSON.stringify({ type: 'control_cancel_request', request_id: 'r' })), null);
  // 缺 request_id / 缺 subtype / input 不是对象：硬化为忽略或空对象
  assert.equal(parseCcLine(JSON.stringify({ type: 'control_request', request: { subtype: 'can_use_tool' } })), null);
  assert.equal(parseCcLine(JSON.stringify({ type: 'control_request', request_id: 'r' })), null);
  const ev = parseCcLine(JSON.stringify({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: 'oops' } }));
  assert.deepEqual(ev.input, {}, 'non-object input hardens to an empty object');
  assert.equal(ev.toolUseId, null, 'missing tool_use_id hardens to null');
});

test('summarizeToolInput picks the human-relevant field per tool', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'rm -rf /tmp/x', description: 'clean' }), 'Bash rm -rf /tmp/x');
  assert.equal(summarizeToolInput('Write', { file_path: '/tmp/a.txt', content: 'x' }), 'Write /tmp/a.txt');
  assert.equal(summarizeToolInput('WebFetch', { url: 'https://x.example', prompt: 'p' }), 'WebFetch https://x.example');
  // 无已知字段 → 紧凑 JSON；超长 → 截断到 160
  assert.equal(summarizeToolInput('Foo', { a: 1 }), 'Foo {"a":1}');
  const long = 'y'.repeat(300);
  const s = summarizeToolInput('Bash', { command: long });
  assert.equal(s.length, 160);
  assert.ok(s.endsWith('...'));
  // input 异常形状不抛
  assert.equal(summarizeToolInput('Bash', null), 'Bash {}');
});

test('buildControlResponse emits the exact SDK wire shape', () => {
  assert.deepEqual(
    buildControlResponse('req-9', { allow: true, input: { command: 'ls' }, toolUseId: 'tu-7' }),
    {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-9',
        response: { behavior: 'allow', updatedInput: { command: 'ls' }, toolUseID: 'tu-7' },
      },
    },
  );
  assert.deepEqual(
    buildControlResponse('req-9', { allow: false, message: 'denied by user', toolUseId: 'tu-7' }),
    {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-9',
        response: { behavior: 'deny', message: 'denied by user', toolUseID: 'tu-7' },
      },
    },
  );
  // 未知 tool_use_id：省略 toolUseID 字段（CLI 按容忍路径处理）
  assert.deepEqual(
    buildControlResponse('r', { allow: false }).response.response,
    { behavior: 'deny', message: 'denied by user' },
  );
});

// gate 判定：供路由回退使用
test('detects agentic-harness gate errors', async () => {
  const { isGateError } = await import('../src/adapters/cc-stream.mjs');
  assert.equal(isGateError('403 agentic harness'), true);
  assert.equal(isGateError('only available on agentic harnesses'), true);
  assert.equal(isGateError('random 400'), false);
});
