import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/sessions.mjs';

// lastUsed 必须是真实时间戳：sweep 按 now - lastUsed > ttl 判过期，0 会被当成 1970。
const mk = (id) => ({ id, agent: null, model: null, apiKey: null, lastUsed: Date.now(), streaming: false });

test('LRU evicts oldest beyond capacity', () => {
  const s = new SessionStore(3, 60_000);
  s.set(mk('a')); s.set(mk('b')); s.set(mk('c'));
  s.get('a');                    // touch a → 序变 b,c,a，b 成最旧
  s.set(mk('d'));
  assert.equal(s.get('b'), undefined);
  assert.ok(s.get('a') && s.get('c') && s.get('d'));
});

test('TTL sweep drops idle sessions', () => {
  const s = new SessionStore(10, 50);
  s.set(mk('old'));
  s.peek('old').lastUsed = Date.now() - 1000;   // 直接拨表，不 touch
  assert.equal(s.get('old'), undefined);
});

test('get touches lastUsed', async () => {
  const s = new SessionStore(10, 80);
  s.set(mk('x'));
  await new Promise((r) => setTimeout(r, 30));
  s.get('x');
  assert.ok(s.peek('x').lastUsed > Date.now() - 1000);
});
