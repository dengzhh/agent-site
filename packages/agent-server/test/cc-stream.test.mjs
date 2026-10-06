import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCcLine } from '../src/adapters/cc-stream.mjs';

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

// gate 判定：供路由回退使用
test('detects agentic-harness gate errors', async () => {
  const { isGateError } = await import('../src/adapters/cc-stream.mjs');
  assert.equal(isGateError('403 agentic harness'), true);
  assert.equal(isGateError('only available on agentic harnesses'), true);
  assert.equal(isGateError('random 400'), false);
});
