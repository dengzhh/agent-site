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

test('get touches lastUsed (back-dated session survives only via get)', () => {
  const s = new SessionStore(10, 60_000);
  s.set(mk('x'));
  // 把 lastUsed 拨回 TTL 之内不久的过去：若 get 不 touch，下一次 set 的清扫会逐掉它
  s.peek('x').lastUsed = Date.now() - 59_000;
  const t = Date.now();
  const got = s.get('x');
  assert.ok(got, 'back-dated session still retrievable');
  assert.ok(s.peek('x').lastUsed >= t, 'get stamped a fresh lastUsed');
  // get 刚 touch 过 → 再触发一次清扫不会逐掉
  s.set(mk('y'));
  assert.ok(s.peek('x'), 'touched session survived the next sweep');
});

test('set stamps lastUsed when missing or zero (immortality/instakill guard)', () => {
  const s = new SessionStore(10, 50);
  const noStamp = { id: 'n' };
  s.set(noStamp);
  assert.ok(typeof noStamp.lastUsed === 'number' && noStamp.lastUsed > 0);
  const zero = { id: 'z', lastUsed: 0 };
  s.set(zero);
  assert.ok(zero.lastUsed > 0, 'zero lastUsed re-stamped instead of instant sweep');
  assert.ok(s.get('n') && s.get('z'));
});

test('constructor rejects non-positive capacity', () => {
  assert.throws(() => new SessionStore(0), TypeError);
  assert.throws(() => new SessionStore(-1), TypeError);
});
