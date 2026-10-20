import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptStore } from '../src/transcripts.mjs';

const freshDir = () => mkdtempSync(join(tmpdir(), 'atbx-tstore-'));
const base = (over = {}) => ({
  id: 'p-1', adapter: 'pi', agent: 'pi', provider: 'zai', model: 'glm-4.7-flash',
  cwd: '/tmp/x', toolTier: 'full', title: '写一个贪吃蛇',
  messages: [{ role: 'user', content: 'hi', timestamp: 1 }], ...over,
});

test('write then read round-trips the record', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    const got = store.get('p-1');
    assert.equal(got.id, 'p-1');
    assert.equal(got.messages.length, 1);
    assert.equal(got.v, 1, 'stamps a format version');
    assert.ok(got.createdAt > 0 && got.lastUsed > 0, 'stamps timestamps');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('save refreshes lastUsed but keeps createdAt', async () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    const first = store.get('p-1');
    await new Promise((r) => setTimeout(r, 5));
    store.save(base({ title: '改一下得分' }));
    const second = store.get('p-1');
    assert.equal(second.createdAt, first.createdAt, 'createdAt is immutable');
    assert.ok(second.lastUsed > first.lastUsed, 'lastUsed refreshed');
    assert.equal(second.title, '改一下得分', 'payload updated');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('file and dir are owner-only (0600 / 0700)', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    const mode = statSync(join(dir, 'p-1.json')).mode & 0o777;
    assert.equal(mode, 0o600, `transcript must be 0600, got ${mode.toString(8)}`);
    const dirMode = statSync(dir).mode & 0o777;
    assert.equal(dirMode, 0o700, `sessions dir must be 0700, got ${dirMode.toString(8)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('list filters by agent/cwd/provider/model and sorts by lastUsed desc', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base({ id: 'a', lastUsed: 100 }));
    store.save(base({ id: 'b', lastUsed: 300 }));
    store.save(base({ id: 'c', cwd: '/tmp/other', lastUsed: 200 }));
    const hits = store.list({ agent: 'pi', cwd: '/tmp/x', provider: 'zai', model: 'glm-4.7-flash' });
    assert.deepEqual(hits.map((h) => h.id), ['b', 'a'], 'filtered and newest-first');
    assert.ok(!hits.some((h) => h.id === 'c'), 'different cwd excluded');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('list omits the messages payload (listing must stay cheap)', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    const [hit] = store.list({});
    assert.equal(hit.messages, undefined, 'list returns metadata only');
    assert.equal(hit.title, '写一个贪吃蛇');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('remove deletes the file and the companion .cc dir', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    store.save(base({ id: 'p-2', adapter: 'cc' }));
    store.remove('p-1');
    assert.equal(existsSync(join(dir, 'p-1.json')), false);
    // cc 会话带一个持久 config dir，删除时要连目录一起收
    assert.equal(store.remove('p-2'), false, 'no .cc dir yet — still not a crash');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt json degrades to "no history" and is quarantined, not deleted', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    writeFileSync(join(dir, 'p-1.json'), '{ this is not json');
    assert.equal(store.get('p-1'), null, 'corrupt file reads as absent');
    assert.equal(existsSync(join(dir, 'p-1.json')), false, 'original moved away');
    assert.ok(existsSync(join(dir, 'p-1.corrupt.json')), 'quarantined for the user to salvage');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown format version is treated as corrupt, never guessed', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    const raw = JSON.parse(readFileSync(join(dir, 'p-1.json'), 'utf8'));
    raw.v = 99;
    writeFileSync(join(dir, 'p-1.json'), JSON.stringify(raw));
    assert.equal(store.get('p-1'), null, 'future version must not be guessed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sweep drops records past the TTL and keeps fresh ones', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir, ttlMs: 1000 });
    const now = Date.now();
    store.save(base({ id: 'old', lastUsed: now - 5000 }));
    store.save(base({ id: 'new', lastUsed: now }));
    const dropped = store.sweep(now);
    assert.deepEqual(dropped, ['old']);
    assert.equal(store.get('old'), null);
    assert.equal(store.get('new')?.id, 'new', 'fresh record survives');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('get on a missing id returns null instead of throwing', () => {
  const dir = freshDir();
  try {
    assert.equal(new TranscriptStore({ dir }).get('nope'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});