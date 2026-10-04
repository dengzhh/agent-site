import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSSE } from '../src/sse.mjs';

test('encodeSSE wraps JSON payload in data block', () => {
  assert.equal(encodeSSE('delta', { text: 'hi\nthere' }), `data: {"text":"hi\\nthere","type":"delta"}\n\n`);
});

test('payload type key cannot override the event type', () => {
  assert.equal(encodeSSE('delta', { text: 'x', type: 'evil' }), `data: {"text":"x","type":"delta"}\n\n`);
});

test('encodeSSE comment heartbeat', () => {
  assert.equal(encodeSSE(null, null), ': ping\n\n');
});
