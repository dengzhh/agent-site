import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSSE } from '../src/sse.mjs';

test('encodeSSE wraps JSON payload in data block', () => {
  assert.equal(encodeSSE('delta', { text: 'hi\nthere' }), `data: {"type":"delta","text":"hi\\nthere"}\n\n`);
});

test('encodeSSE comment heartbeat', () => {
  assert.equal(encodeSSE(null, null), ': ping\n\n');
});
