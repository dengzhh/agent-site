import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
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
  // mkdtempSync 本来就建出 0700，直接断言等于什么都没测。
  // 先故意把目录放宽，再让构造函数去收紧——这才是在测它的行为。
  const parent = freshDir();
  const dir = join(parent, 'loose');
  try {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    assert.equal(statSync(dir).mode & 0o777, 0o755, 'precondition: dir really is loose');
    const store = new TranscriptStore({ dir });
    store.save(base());
    const mode = statSync(join(dir, 'p-1.json')).mode & 0o777;
    assert.equal(mode, 0o600, `transcript must be 0600, got ${mode.toString(8)}`);
    const dirMode = statSync(dir).mode & 0o777;
    assert.equal(dirMode, 0o700, `constructor must tighten dir to 0700, got ${dirMode.toString(8)}`);
  } finally { rmSync(parent, { recursive: true, force: true }); }
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
    // cc 会话带一个持久 config dir（--resume 依赖它），删除时要连目录一起收。
    // 造一个假的 .cc 目录来验证这条路径，别只靠「不抛异常」蒙过去。
    mkdirSync(join(dir, 'p-2.cc'), { recursive: true });
    store.remove('p-1');
    assert.equal(existsSync(join(dir, 'p-1.json')), false);
    assert.equal(store.remove('p-2'), true, 'the record existed, so it was removed');
    assert.equal(existsSync(join(dir, 'p-2.json')), false, 'json gone');
    assert.equal(existsSync(join(dir, 'p-2.cc')), false, 'companion .cc dir gone');
    assert.equal(store.remove('p-2'), false, 'second call is a no-op');
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

// Task 6 会把请求体里的 persistId 直接喂给 get/remove，那时 id 就成了
// 用户可控的路径片段。落盘/删除前必须挡住 traversal。
test('a traversal id cannot write outside the store dir', () => {
  const parent = freshDir();
  const dir = join(parent, 'sub');
  try {
    const store = new TranscriptStore({ dir });
    // ../VICTIM 正好落在 parent/VICTIM.json——canary 必须放在「真写会落的地方」，
    // 否则断言的是一个没人会碰的路径，等于没测
    writeFileSync(join(parent, 'VICTIM.json'), 'CANARY');
    assert.throws(() => store.save(base({ id: '../VICTIM' })), TypeError,
      'save fails loud on a programmer-error id');
    assert.equal(readFileSync(join(parent, 'VICTIM.json'), 'utf8'), 'CANARY',
      'the file a real write would have clobbered is untouched');
    assert.deepEqual(readdirSync(dir), [], 'nothing written inside dir either');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

// 上一条只测了 save。这条给 get/remove 配一个真实存在的受害文件：
// 只断言「查无此项」的话，把 #readableId 改成 return true 也照样全绿。
test('traversal on get/remove cannot reach a real file outside the dir', () => {
  const parent = freshDir();
  const dir = join(parent, 'sub');
  try {
    const store = new TranscriptStore({ dir });
    const victim = join(parent, 'x.json');
    writeFileSync(victim, JSON.stringify({ v: 1, id: 'x', secret: 'CANARY' }));
    assert.equal(store.get('../x'), null, 'get must not read outside the dir');
    assert.equal(store.remove('../x'), false, 'remove must report nothing done');
    assert.equal(readFileSync(victim, 'utf8').includes('CANARY'), true,
      'the outside file survived both calls');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('bad ids: save throws, get/remove return empty (route input is not an exception)', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    assert.throws(() => store.save(base({ id: '../x' })), TypeError);
    assert.throws(() => store.save(base({ id: 'a/b' })), TypeError);
    assert.throws(() => store.save(base({ id: '' })), TypeError);
    assert.throws(() => store.save(base({ id: 'x'.repeat(129) })), TypeError);
    // 同一个 id 走读/删路径只该「查无此项」，不该把异常抛到 HTTP 层
    assert.equal(store.get('../x'), null);
    assert.equal(store.get('a/b'), null);
    assert.equal(store.remove('a/b'), false);
    // 合法 id 不受影响：UUID 形态要放行
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    store.save(base({ id: uuid }));
    assert.equal(store.get(uuid)?.id, uuid);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('quarantine does not compound across repeated list/sweep', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    writeFileSync(join(dir, 'p-1.json'), '{ this is not json');
    store.get('p-1');
    assert.ok(existsSync(join(dir, 'p-1.corrupt.json')), 'quarantined on first read');
    for (let i = 0; i < 5; i++) { store.list({}); store.sweep(); }
    const files = readdirSync(dir);
    assert.deepEqual(files, ['p-1.corrupt.json'], `name must not grow, got ${files.join(', ')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a planted traversal payload id cannot drive clear() outside the dir', () => {
  const parent = freshDir();
  const dir = join(parent, 'sub');
  try {
    const store = new TranscriptStore({ dir });
    // 绕过 save/get/remove，直接在盘上放一个「payload id 带 traversal」的文件。
    // list() 过去的版本会把它原样吐出来，clear() 于是拿它去拼路径删到 dir 外。
    writeFileSync(join(dir, 'planted.json'), JSON.stringify({
      v: 1, id: '../VICTIM', agent: 'pi', lastUsed: 1, title: 'planted',
    }));
    const canary = join(parent, 'VICTIM.json');
    writeFileSync(canary, 'CANARY');
    assert.deepEqual(store.list({}), [], 'malformed id must not reach the caller');
    assert.equal(store.clear({}), 0, 'nothing to clear — nothing attempted');
    assert.equal(readFileSync(canary, 'utf8'), 'CANARY', 'file outside dir untouched');
    // 坏 id 是「损坏」的一种，处置方式应与已知策略一致：隔离而非原地留着被反复读
    assert.deepEqual(readdirSync(dir), ['planted.corrupt.json'], 'quarantined');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

// 兜底：denylist 永远追不上所有拼法（大小写、嵌套、env 里的同名变量…），
// 所以改成白名单——不在 spec 字段表里的，一律不落盘。
test('no credential spelling reaches disk, at any depth or casing', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const saved = store.save(base({
      apiKey: 'sk-1', authorization: 'Bearer sk-2', token: 'sk-3', APIKEY: 'sk-4',
      nested: { apiKey: 'sk-5', deep: { token: 'sk-6' } },
      env: { ANTHROPIC_API_KEY: 'sk-7' },
      headers: { authorization: 'Bearer sk-8' },
      junk: 'sk-9',
    }));
    const raw = readFileSync(join(dir, 'p-1.json'), 'utf8');
    for (let i = 1; i <= 9; i++) {
      assert.ok(!raw.includes(`sk-${i}`), `sk-${i} must not be on disk: ${raw}`);
    }
    // 剥离要发生在返回值上，调用方不能把刚写的 key 又读回来
    assert.equal(saved.apiKey, undefined);
    assert.equal(saved.nested, undefined);
    assert.equal(saved.env, undefined);
    assert.equal(saved.junk, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 白名单的反面风险：哪天少写一个字段，transcript 静默丢数据。所以钉住
// spec 的完整字段表必须原样往返。
test('every spec field round-trips unchanged (allowlist is complete)', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const full = {
      id: 'full-1', adapter: 'cc', agent: 'cc', provider: 'zai', model: 'glm-4.7',
      cwd: '/tmp/work', toolTier: 'full', title: '完整形态',
      messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
      piSessionId: 'pi-abc', ccSessionId: 'cc-xyz',
      createdAt: 111, lastUsed: 222,
    };
    store.save(full);
    const got = store.get('full-1');
    for (const [k, v] of Object.entries(full)) {
      if (k === 'createdAt' || k === 'lastUsed') continue;   // save 会按规则盖时间戳
      assert.deepEqual(got[k], v, `field ${k} must survive the allowlist`);
    }
    assert.equal(got.v, 1, 'format version stamped');
    // 列表侧同样要带得出这些字段（只是没有 messages）
    const [hit] = store.list({});
    assert.equal(hit.ccSessionId, 'cc-xyz');
    assert.equal(hit.piSessionId, 'pi-abc');
    assert.equal(hit.messages, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 这条要真的打到 rename 那一步：之前用循环引用让 JSON.stringify 抛，
// 而 stringify 发生在 writeFileSync 之前，压根没建过 tmp，删不删都能过。
test('a failed rename leaves no stale .tmp behind', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base());
    // 在最终路径上摆一个目录：tmp 写得出来，renameSync 挪不动（EISDIR/ENOTEMPTY）
    mkdirSync(join(dir, 'blocked.json'));
    assert.throws(() => store.save(base({ id: 'blocked' })));
    assert.deepEqual(readdirSync(dir), ['blocked.json', 'p-1.json'], 'no .tmp residue');
    assert.equal(store.get('p-1').title, '写一个贪吃蛇', 'pre-existing record undamaged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// createdAt/lastUsed 不在白名单里，却是直接取自 rec 赋值——于是这两个字段
// 成了绕过白名单的暗道。任何对象塞进去都会原样落盘。
test('the timestamp fields cannot smuggle a value onto disk', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    store.save(base({ createdAt: { apiKey: 'sk-C1' }, lastUsed: { authorization: 'Bearer sk-L1' } }));
    const raw = readFileSync(join(dir, 'p-1.json'), 'utf8');
    assert.ok(!raw.includes('sk-C1'), `createdAt must not carry a payload: ${raw}`);
    assert.ok(!raw.includes('sk-L1'), `lastUsed must not carry a payload: ${raw}`);
    // 兜底：两个字段必须是数字，不能是对象
    const got = store.get('p-1');
    assert.equal(typeof got.createdAt, 'number');
    assert.equal(typeof got.lastUsed, 'number');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// NaN 比较恒为 false，所以一个 lastUsed 不是数字的记录永远不会过期。
// 那等于一条永生记录，TTL 形同虚设。
test('a non-numeric lastUsed cannot make a record immortal', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir, ttlMs: 1000 });
    store.save(base({ id: 'garbage', lastUsed: 'not-a-number' }));
    store.save(base({ id: 'obj', lastUsed: { evil: true } }));
    const now = Date.now();
    assert.deepEqual(store.sweep(now + 5000).sort(), ['garbage', 'obj'],
      'both fall back to a real timestamp and expire normally');
    assert.equal(store.get('garbage'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 时间戳回填（导入/迁移）仍须被接受——num() 只挡非数字，不是不要显式值。
test('numeric timestamp overrides are still honoured', () => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir, ttlMs: 1000 });
    store.save(base({ id: 'back', createdAt: 1000, lastUsed: 2000 }));
    const got = store.get('back');
    assert.equal(got.createdAt, 1000, 'explicit numeric createdAt kept');
    assert.equal(got.lastUsed, 2000, 'explicit numeric lastUsed kept');
    assert.deepEqual(store.sweep(4000), ['back'], 'and it expires on its own schedule');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});