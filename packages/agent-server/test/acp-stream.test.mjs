import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSessionUpdate } from '../src/adapters/acp-stream.mjs';

test('agent_message_chunk becomes a delta', () => {
  const p = { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } } };
  assert.deepEqual(mapSessionUpdate(p), [{ type: 'delta', text: 'PONG' }]);
});

test('agent_thought_chunk becomes a thinking event', () => {
  const p = { sessionId: 's', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } };
  assert.deepEqual(mapSessionUpdate(p), [{ type: 'thinking', text: 'hmm' }]);
});

test('usage_update is captured, not streamed as text', () => {
  const p = { sessionId: 's', update: { sessionUpdate: 'usage_update', usage: { inputTokens: 10, outputTokens: 2 } } };
  const out = mapSessionUpdate(p);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'usage');
  assert.deepEqual(out[0].usage, { inputTokens: 10, outputTokens: 2 });
});

test('tool_call updates are surfaced as activity, not text', () => {
  const p = { sessionId: 's', update: { sessionUpdate: 'tool_call', title: 'Read file' } };
  const out = mapSessionUpdate(p);
  assert.equal(out[0].type, 'activity');
  assert.equal(out[0].title, 'Read file');
});

test('unknown update kinds yield no events', () => {
  assert.deepEqual(mapSessionUpdate({ update: { sessionUpdate: 'plan' } }), []);
  assert.deepEqual(mapSessionUpdate({}), []);
  assert.deepEqual(mapSessionUpdate(null), []);
});

test('empty or missing text is skipped', () => {
  assert.deepEqual(mapSessionUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { text: '' } } }), []);
  assert.deepEqual(mapSessionUpdate({ update: { sessionUpdate: 'agent_message_chunk' } }), []);
});
