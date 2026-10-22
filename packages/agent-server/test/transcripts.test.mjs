import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { TranscriptStore, spoke } from '../src/transcripts.mjs';

const freshDir = () => mkdtempSync(join(tmpdir(), 'atbx-tstore-'));
const base = (over = {}) => ({
  id: 'p-1', adapter: 'pi', agent: 'pi', provider: 'zai', model: 'glm-4.7-flash',
  cwd: '/tmp/x', toolTier: 'full', title: '写一个贪吃蛇',
  messages: [{ role: 'user', content: 'hi', timestamp: 1 }], ...over,
});
// 每个用例一个自己的临时目录，t.after 收摊——省掉 21 遍 try/finally
const tmpStore = (t, opts = {}) => {
  const dir = freshDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new TranscriptStore({ dir, ...opts }) };
};

test('write then read round-trips the record', (t) => {
  const { store } = tmpStore(t);
  store.save(base());
  const got = store.get('p-1');
  assert.equal(got.id, 'p-1');
  assert.equal(got.messages.length, 1);
  assert.equal(got.v, 1, 'stamps a format version');
  assert.ok(got.createdAt > 0 && got.lastUsed > 0, 'stamps timestamps');
});

test('save refreshes lastUsed but keeps createdAt', async (t) => {
  const { store } = tmpStore(t);
  store.save(base());
  const first = store.get('p-1');
  await new Promise((r) => setTimeout(r, 5));
  store.save(base({ title: '改一下得分' }));
  const second = store.get('p-1');
  assert.equal(second.createdAt, first.createdAt, 'createdAt is immutable');
  assert.ok(second.lastUsed > first.lastUsed, 'lastUsed refreshed');
  assert.equal(second.title, '改一下得分', 'payload updated');
});

test('file and dir are owner-only (0600 / 0700)', (t) => {
  // mkdtempSync 本来就建出 0700，直接断言等于什么都没测。
  // 先故意把目录放宽，再让构造函数去收紧——这才是在测它的行为。
  const parent = freshDir();
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = join(parent, 'loose');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  assert.equal(statSync(dir).mode & 0o777, 0o755, 'precondition: dir really is loose');
  const store = new TranscriptStore({ dir });
  store.save(base());
  const mode = statSync(join(dir, 'p-1.json')).mode & 0o777;
  assert.equal(mode, 0o600, `transcript must be 0600, got ${mode.toString(8)}`);
  const dirMode = statSync(dir).mode & 0o777;
  assert.equal(dirMode, 0o700, `constructor must tighten dir to 0700, got ${dirMode.toString(8)}`);
});

// 收紧只 chmod 是不够的：新建的那一瞬也得是 0700，不能留 0755 的窗口。
test('a newly created store dir is 0700 from the start', (t) => {
  const parent = freshDir();
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = join(parent, 'fresh');
  new TranscriptStore({ dir });
  assert.equal(statSync(dir).mode & 0o777, 0o700,
    'a brand new dir must never be briefly world-readable');
});

test('list filters by agent/cwd/provider/model and sorts by lastUsed desc', (t) => {
  const { store } = tmpStore(t);
  store.save(base({ id: 'a', lastUsed: 100 }));
  store.save(base({ id: 'b', lastUsed: 300 }));
  store.save(base({ id: 'c', cwd: '/tmp/other', lastUsed: 200 }));
  const hits = store.list({ agent: 'pi', cwd: '/tmp/x', provider: 'zai', model: 'glm-4.7-flash' });
  assert.deepEqual(hits.map((h) => h.id), ['b', 'a'], 'filtered and newest-first');
  assert.ok(!hits.some((h) => h.id === 'c'), 'different cwd excluded');
});

test('list omits the messages payload (listing must stay cheap)', (t) => {
  const { store } = tmpStore(t);
  store.save(base());
  const [hit] = store.list({});
  assert.equal(hit.messages, undefined, 'list returns metadata only');
  assert.equal(hit.title, '写一个贪吃蛇');
});

// ── hideEmpty：把「建了会话但没说过话」的空壳挡在历史列表之外 ──────────────
// 背景：网关在建会话时就落盘（筛选四维必须及时写，否则 GET /sessions 命中 0 条，
// 前端自动恢复会废掉），于是每开一次抽屉就留一条无 messages 的记录，用户看到
// 一排「(无标题)」。落盘时机不能改（Task 6 的地基），故在读取侧过滤。
//
// ⚠️ 判据是「这条记录能不能被恢复」，**不是**「记录里有没有 messages」。
// cc 的历史在 CLI 自己的 jsonl 里，靠 --resume 续，我们的记录只留
// configDir/ccSessionId 两个指针，永远没有 messages。9e35bb7 按 messages 判，
// 结果把 cc/acp 的真会话全筛掉、只剩 pi 的空壳——用户看到的就是
// 「换模型进 chat，历史全没了」。下面每条 cc 用例都是钉这个回归的。

test('list({hideEmpty:true}) drops records with no messages', (t) => {
  const { store } = tmpStore(t);
  store.save(base({ id: 'real', lastUsed: 200 }));
  // 空会话：建会话时 server.mjs 只写配置四维，没有 messages
  store.save({ id: 'empty', adapter: 'pi', agent: 'pi', provider: 'zai',
               model: 'glm-4.7-flash', cwd: '/tmp/x', toolTier: 'full' });
  // cc 的桩记录：configDir 已建、ccSessionId 显式为 null，也还没有 messages
  store.save({ id: 'stub', adapter: 'cc', agent: 'cc', provider: 'zai',
               model: 'glm-4.7-flash', cwd: '/tmp/x', toolTier: 'full',
               configDir: '/tmp/x.cc', ccSessionId: null });
  const ids = store.list({}, { hideEmpty: true }).map((r) => r.id);
  assert.deepEqual(ids, ['real'], 'empty and stub records are hidden');
});

// 回归的主用例：cc 跑完一轮后记录里**没有** messages（历史在 CLI 的 jsonl 里），
// 但 ccSessionId 是这一轮真的跑完了的凭据——它必须算「说过话」。
test('hideEmpty keeps a cc session that ran a turn even without messages', (t) => {
  const { store } = tmpStore(t);
  store.save(base({ id: 'pi-real', lastUsed: 200 }));
  // cc.mjs 在 turn_end 时写的正是这三个字段——与生产写入逐字段一致
  store.save({ id: 'cc-real', adapter: 'cc', agent: 'cc', provider: 'zai',
               model: 'glm-4.7-flash', cwd: '/tmp/x', toolTier: 'full',
               configDir: '/tmp/x.cc', ccSessionId: 'f05c80fa-ac8e-471c-b98d' });
  const ids = store.list({}, { hideEmpty: true }).map((r) => r.id);
  // 排序用 .sort()：两条 lastUsed 同在写入毫秒，先后不保证，故比集合不比顺序
  assert.deepEqual([...ids].sort(), ['cc-real', 'pi-real'],
    'a cc session that completed a turn is history, messages or not');
});

// 桩记录与「跑过一轮的 cc」之别就在 ccSessionId 是 null 还是字符串：
// 建目录时写的是 null（首轮成功前 restore() 必须返回 null），跑完才是 UUID。
test('hideEmpty tells a cc stub from a finished cc turn by ccSessionId', (t) => {
  const { store } = tmpStore(t);
  store.save({ id: 'stub', adapter: 'cc', agent: 'cc', provider: 'zai',
               model: 'glm-4.7-flash', cwd: '/tmp/x', toolTier: 'full',
               configDir: '/tmp/x.cc', ccSessionId: null });
  store.save({ id: 'stub-empty-str', adapter: 'cc', agent: 'cc', provider: 'zai',
               model: 'glm-4.7-flash', cwd: '/tmp/x', toolTier: 'full',
               configDir: '/tmp/x.cc', ccSessionId: '' });
  store.save({ id: 'ran', adapter: 'cc', agent: 'cc', provider: 'zai',
               model: 'glm-4.7-flash', cwd: '/tmp/x', toolTier: 'full',
               configDir: '/tmp/x.cc', ccSessionId: '11111111-2222' });
  assert.deepEqual(store.list({}, { hideEmpty: true }).map((r) => r.id), ['ran'],
    'only a real cc session id counts as having spoken');
});

// acp 每轮都是 newSession，不落任何凭据 → 不可恢复 → 不该出现在列表里。
// 前端 canRestore() 只认 pi|cc，出现一条点不开的历史是欺骗。
test('hideEmpty drops acp records (they can never be resumed)', (t) => {
  const { store } = tmpStore(t);
  store.save(base({ id: 'pi-real' }));
  store.save({ id: 'acp-one', adapter: 'acp', agent: 'acp:hermes', provider: 'zai',
               model: 'glm-4.7-flash', cwd: '/tmp/x', toolTier: 'full' });
  assert.deepEqual(store.list({}, { hideEmpty: true }).map((r) => r.id), ['pi-real'],
    'acp history is not restorable, so it is not history in the list');
});

// 判据单独钉一层：spoke() 是这套语义的唯一出处，前端 canRestore() 与它对齐。
test('spoke() judges restorability, not the presence of messages', (t) => {
  const { store } = tmpStore(t);
  store.save(base({ id: 'pi' }));
  store.save({ id: 'cc', adapter: 'cc', agent: 'cc', ccSessionId: 'abc' });
  store.save({ id: 'cc-stub', adapter: 'cc', agent: 'cc', ccSessionId: null });
  store.save({ id: 'acp', adapter: 'acp', agent: 'acp:hermes' });
  store.save({ id: 'blank', messages: [] });
  const byId = (id) => store.get(id);
  assert.equal(spoke(byId('pi')), true, 'pi with messages spoke');
  assert.equal(spoke(byId('cc')), true, 'cc with a session id spoke');
  assert.equal(spoke(byId('cc-stub')), false, 'cc stub has not spoken');
  assert.equal(spoke(byId('acp')), false, 'acp leaves nothing restorable');
  assert.equal(spoke(byId('blank')), false, 'empty messages array is not speech');
  assert.equal(spoke(null), false, 'no record, no speech');
});

test('list() without hideEmpty still returns empty records (default unchanged)', (t) => {
  const { store } = tmpStore(t);
  store.save(base({ id: 'real' }));
  store.save({ id: 'empty', adapter: 'pi', agent: 'pi', provider: 'zai',
               model: 'glm-4.7-flash', cwd: '/tmp/x', toolTier: 'full' });
  assert.deepEqual(store.list({}).map((r) => r.id).sort(), ['empty', 'real'],
    'default must keep every record: sweep/remove/tests rely on it');
});

// 有 messages 但内容为空的数组，等同于没说成话——一样挡掉。
test('list({hideEmpty:true}) treats an empty messages array as empty', (t) => {
  const { store } = tmpStore(t);
  store.save(base({ id: 'real', messages: [{ role: 'user', content: 'hi' }] }));
  store.save(base({ id: 'blank', messages: [] }));
  assert.deepEqual(store.list({}, { hideEmpty: true }).map((r) => r.id), ['real']);
});

// 过滤只在读取侧：桩记录照样能被 remove() 找到并收回它的 configDir，
// 否则 cc 的隔离目录会永久泄漏在磁盘上。
test('hideEmpty hides the stub but remove() still reclaims its configDir', (t) => {
  const { dir, store } = tmpStore(t);
  const cfg = join(dir, 'stub.cc');
  mkdirSync(cfg, { recursive: true });
  store.save({ id: 'stub', adapter: 'cc', agent: 'cc', provider: 'zai',
               model: 'glm-4.7-flash', cwd: '/tmp/x', toolTier: 'full',
               configDir: cfg, ccSessionId: null });
  assert.deepEqual(store.list({}, { hideEmpty: true }).map((r) => r.id), [], 'stub hidden');
  assert.ok(existsSync(cfg), 'dir still there while the record exists');
  assert.equal(store.remove('stub'), true, 'remove() must still find it');
  assert.ok(!existsSync(cfg), 'remove() reclaims the cc config dir');
});

// hideEmpty 与筛选四维同时用时，两个条件都要成立才算命中。
test('hideEmpty composes with the four-dimension filter', (t) => {
  const { store } = tmpStore(t);
  store.save(base({ id: 'match' }));
  store.save(base({ id: 'other-cwd', cwd: '/tmp/elsewhere' }));
  store.save({ id: 'match-but-empty', adapter: 'pi', agent: 'pi', provider: 'zai',
               model: 'glm-4.7-flash', cwd: '/tmp/x', toolTier: 'full' });
  const hits = store.list({ agent: 'pi', cwd: '/tmp/x', provider: 'zai', model: 'glm-4.7-flash' }, { hideEmpty: true });
  assert.deepEqual(hits.map((r) => r.id), ['match'], 'both filters apply');
});

test('remove deletes the file and the companion .cc dir', (t) => {
  const { dir, store } = tmpStore(t);
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
});

test('corrupt json degrades to "no history" and is quarantined, not deleted', (t) => {
  const { dir, store } = tmpStore(t);
  store.save(base());
  writeFileSync(join(dir, 'p-1.json'), '{ this is not json');
  assert.equal(store.get('p-1'), null, 'corrupt file reads as absent');
  assert.equal(existsSync(join(dir, 'p-1.json')), false, 'original moved away');
  assert.ok(existsSync(join(dir, 'p-1.corrupt.json')), 'quarantined for the user to salvage');
});

test('unknown format version is treated as corrupt, never guessed', (t) => {
  const { dir, store } = tmpStore(t);
  store.save(base());
  const raw = JSON.parse(readFileSync(join(dir, 'p-1.json'), 'utf8'));
  raw.v = 99;
  writeFileSync(join(dir, 'p-1.json'), JSON.stringify(raw));
  assert.equal(store.get('p-1'), null, 'future version must not be guessed');
});

test('sweep drops records past the TTL and keeps fresh ones', (t) => {
  const { store } = tmpStore(t, { ttlMs: 1000 });
  const now = Date.now();
  store.save(base({ id: 'old', lastUsed: now - 5000 }));
  store.save(base({ id: 'new', lastUsed: now }));
  const dropped = store.sweep(now);
  assert.deepEqual(dropped, ['old']);
  assert.equal(store.get('old'), null);
  assert.equal(store.get('new')?.id, 'new', 'fresh record survives');
});

test('get on a missing id returns null instead of throwing', (t) => {
  const { store } = tmpStore(t);
  assert.equal(store.get('nope'), null);
});

// Task 6 会把请求体里的 persistId 直接喂给 get/remove，那时 id 就成了
// 用户可控的路径片段。落盘/删除前必须挡住 traversal。
test('a traversal id cannot write outside the store dir', (t) => {
  const parent = freshDir();
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = join(parent, 'sub');
  const store = new TranscriptStore({ dir });
  // ../VICTIM 正好落在 parent/VICTIM.json——canary 必须放在「真写会落的地方」，
  // 否则断言的是一个没人会碰的路径，等于没测
  writeFileSync(join(parent, 'VICTIM.json'), 'CANARY');
  assert.throws(() => store.save(base({ id: '../VICTIM' })), TypeError,
    'save fails loud on a programmer-error id');
  assert.equal(readFileSync(join(parent, 'VICTIM.json'), 'utf8'), 'CANARY',
    'the file a real write would have clobbered is untouched');
  assert.deepEqual(readdirSync(dir), [], 'nothing written inside dir either');
});

// 上一条只测了 save。这条给 get/remove 配一个真实存在的受害文件：
// 只断言「查无此项」的话，把 #readableId 改成 return true 也照样全绿。
test('traversal on get/remove cannot reach a real file outside the dir', (t) => {
  const parent = freshDir();
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = join(parent, 'sub');
  const store = new TranscriptStore({ dir });
  const victim = join(parent, 'x.json');
  writeFileSync(victim, JSON.stringify({ v: 1, id: 'x', secret: 'CANARY' }));
  assert.equal(store.get('../x'), null, 'get must not read outside the dir');
  assert.equal(store.remove('../x'), false, 'remove must report nothing done');
  assert.equal(readFileSync(victim, 'utf8').includes('CANARY'), true,
    'the outside file survived both calls');
});

test('bad ids: save throws, get/remove return empty (route input is not an exception)', (t) => {
  const { store } = tmpStore(t);
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
});

test('quarantine does not compound across repeated list/sweep', (t) => {
  const { dir, store } = tmpStore(t);
  store.save(base());
  writeFileSync(join(dir, 'p-1.json'), '{ this is not json');
  store.get('p-1');
  assert.ok(existsSync(join(dir, 'p-1.corrupt.json')), 'quarantined on first read');
  for (let i = 0; i < 5; i++) { store.list({}); store.sweep(); }
  const files = readdirSync(dir);
  assert.deepEqual(files, ['p-1.corrupt.json'], `name must not grow, got ${files.join(', ')}`);
});

test('a planted traversal payload id cannot drive clear() outside the dir', (t) => {
  const parent = freshDir();
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = join(parent, 'sub');
  const store = new TranscriptStore({ dir });
  // 绕过 save/get/remove，直接在盘上放一个「payload id 带 traversal」的文件。
  // list() 过去的版本会把它原样吐出来，clear() 于是拿它去拼路径删到 dir 外。
  writeFileSync(join(dir, 'planted.json'), JSON.stringify({
    v: 1, id: '../VICTIM', agent: 'pi', lastUsed: 1, title: 'planted',
  }));
  const canary = join(parent, 'VICTIM.json');
  writeFileSync(canary, 'CANARY');
  assert.deepEqual(store.list({}), [], 'malformed id must not reach the caller');
  assert.equal(store.clearAll(), 0, 'nothing to clear — nothing attempted');
  assert.equal(readFileSync(canary, 'utf8'), 'CANARY', 'file outside dir untouched');
  // 坏 id 是「损坏」的一种，处置方式应与已知策略一致：隔离而非原地留着被反复读
  assert.deepEqual(readdirSync(dir), ['planted.corrupt.json'], 'quarantined');
});

// 兜底：denylist 永远追不上所有拼法（大小写、嵌套、env 里的同名变量…），
// 所以改成白名单——不在 spec 字段表里的，一律不落盘。
test('no credential spelling reaches disk, at any depth or casing', (t) => {
  const { dir, store } = tmpStore(t);
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
});

// 白名单的反面风险：哪天少写一个字段，transcript 静默丢数据。所以钉住
// spec 的完整字段表必须原样往返。
test('every spec field round-trips unchanged (allowlist is complete)', (t) => {
  const { store } = tmpStore(t);
  const full = {
    id: 'full-1', adapter: 'cc', agent: 'cc', provider: 'zai', model: 'glm-4.7',
    cwd: '/tmp/work', toolTier: 'full', title: '完整形态',
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
    piSessionId: 'pi-abc', ccSessionId: 'cc-xyz', configDir: '/tmp/work/.cc',
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
  assert.equal(hit.configDir, '/tmp/work/.cc');
  assert.equal(hit.messages, undefined);
});

// 这条要真的打到 rename 那一步：之前用循环引用让 JSON.stringify 抛，
// 而 stringify 发生在 writeFileSync 之前，压根没建过 tmp，删不删都能过。
test('a failed rename leaves no stale .tmp behind', (t) => {
  const { dir, store } = tmpStore(t);
  store.save(base());
  // 在最终路径上摆一个目录：tmp 写得出来，renameSync 挪不动（EISDIR/ENOTEMPTY）
  mkdirSync(join(dir, 'blocked.json'));
  assert.throws(() => store.save(base({ id: 'blocked' })));
  assert.deepEqual(readdirSync(dir), ['blocked.json', 'p-1.json'], 'no .tmp residue');
  assert.equal(store.get('p-1').title, '写一个贪吃蛇', 'pre-existing record undamaged');
});

// createdAt/lastUsed 不在白名单里，却是直接取自 rec 赋值——于是这两个字段
// 成了绕过白名单的暗道。任何对象塞进去都会原样落盘。
test('the timestamp fields cannot smuggle a value onto disk', (t) => {
  const { dir, store } = tmpStore(t);
  store.save(base({ createdAt: { apiKey: 'sk-C1' }, lastUsed: { authorization: 'Bearer sk-L1' } }));
  const raw = readFileSync(join(dir, 'p-1.json'), 'utf8');
  assert.ok(!raw.includes('sk-C1'), `createdAt must not carry a payload: ${raw}`);
  assert.ok(!raw.includes('sk-L1'), `lastUsed must not carry a payload: ${raw}`);
  // 兜底：两个字段必须是数字，不能是对象
  const got = store.get('p-1');
  assert.equal(typeof got.createdAt, 'number');
  assert.equal(typeof got.lastUsed, 'number');
});

// 白名单只回答了「哪些键能落盘」，没回答「键里能装什么」：provider/model
// 本该是字符串，传个对象进去，嵌套的凭据就照样进了 0600 文件。写、读
// 两条路径都得按形状过滤（读路径要挡手写文件），且坏形状不能覆盖已有好值。
test('config fields only accept strings: a nested object cannot smuggle a credential', (t) => {
  const { dir, store } = tmpStore(t);
  store.save(base({ provider: 'zai', model: 'glm-4.7-flash' }));
  store.save(base({
    provider: { apiKey: 'sk-P1' },
    model: { env: { ANTHROPIC_API_KEY: 'sk-M1' } },
    cwd: ['/tmp', 'sk-C1'],
  }));
  const raw = readFileSync(join(dir, 'p-1.json'), 'utf8');
  assert.ok(!raw.includes('sk-'), `no credential reached disk: ${raw}`);
  const got = store.get('p-1');
  assert.equal(got.provider, 'zai', 'a bad shape keeps the previous good value');
  assert.equal(got.model, 'glm-4.7-flash');
  // 读路径也要挡：盘外手写的嵌套对象不能从 get()/list() 端出去
  writeFileSync(join(dir, 'p-2.json'), JSON.stringify({
    v: 1, id: 'p-2', provider: { apiKey: 'sk-P2' }, createdAt: 1, lastUsed: 2,
  }));
  assert.equal(store.get('p-2').provider, undefined, 'read path drops it too');
  // 显式 null 仍是「清空」语义（cc 复位 ccSessionId 靠它）
  store.save({ id: 'p-1', ccSessionId: null });
  assert.equal(store.get('p-1').ccSessionId, null);
});

// NaN 比较恒为 false，所以一个 lastUsed 不是数字的记录永远不会过期。
// 那等于一条永生记录，TTL 形同虚设。
test('a non-numeric lastUsed cannot make a record immortal', (t) => {
  const { store } = tmpStore(t, { ttlMs: 1000 });
  store.save(base({ id: 'garbage', lastUsed: 'not-a-number' }));
  store.save(base({ id: 'obj', lastUsed: { evil: true } }));
  const now = Date.now();
  assert.deepEqual(store.sweep(now + 5000).sort(), ['garbage', 'obj'],
    'both fall back to a real timestamp and expire normally');
  assert.equal(store.get('garbage'), null);
});

// 时间戳回填（导入/迁移）仍须被接受——num() 只挡非数字，不是不要显式值。
test('numeric timestamp overrides are still honoured', (t) => {
  const { store } = tmpStore(t, { ttlMs: 1000 });
  store.save(base({ id: 'back', createdAt: 1000, lastUsed: 2000 }));
  const got = store.get('back');
  assert.equal(got.createdAt, 1000, 'explicit numeric createdAt kept');
  assert.equal(got.lastUsed, 2000, 'explicit numeric lastUsed kept');
  assert.deepEqual(store.sweep(4000), ['back'], 'and it expires on its own schedule');
});

// 写路径挡了非数字 lastUsed，读路径也得挡：否则一个手写的盘外文件
// 可以给自己续命（NaN 比较恒为 false），TTL 直接失效。
test('a hand-written record with a non-numeric lastUsed cannot be immortal', (t) => {
  const { dir, store } = tmpStore(t, { ttlMs: 1000 });
  writeFileSync(join(dir, 'immortal.json'), JSON.stringify({
    v: 1, id: 'immortal', title: 'x', createdAt: 1, lastUsed: 'never',
  }));
  assert.equal(store.get('immortal'), null, 'a bogus timestamp reads as absent');
  assert.deepEqual(store.sweep(Date.now() + 1e9), [], 'and it never expires');
  assert.deepEqual(readdirSync(dir), ['immortal.corrupt.json'], 'quarantined');
});

// 读回也按同一张白名单裁剪：写路径封死了入口，读路径就不该把
// 来路不明的字段原样端给调用方（list 的响应会直接把它送上网）。
test('unknown fields never come back out of get()/list()', (t) => {
  const { dir, store } = tmpStore(t);
  writeFileSync(join(dir, 'x.json'), JSON.stringify({
    v: 1, id: 'x', title: 't', createdAt: 1, lastUsed: 2,
    apiKey: 'sk-LEAK', env: { ANTHROPIC_API_KEY: 'sk-LEAK2' },
  }));
  const got = store.get('x');
  assert.equal(got.apiKey, undefined, 'get() must not echo unknown fields');
  assert.equal(got.env, undefined, 'and neither must their nested payload');
  const [hit] = store.list({});
  assert.equal(hit.apiKey, undefined, 'list() must not echo unknown fields');
  assert.equal(hit.env, undefined);
  assert.equal(hit.title, 't', 'the allowed fields still come through');
});

// 身份以文件名为准：payload 自报的 id 与文件名不一致，说明这份文件被人动过。
test('a record whose payload id disagrees with its filename is quarantined', (t) => {
  const { dir, store } = tmpStore(t);
  store.save(base({ id: 'p-1', title: '真身' }));
  writeFileSync(join(dir, 'p-2.json'), JSON.stringify({
    v: 1, id: 'p-1', title: '冒名', createdAt: 1, lastUsed: 2,
  }));
  assert.deepEqual(store.list({}).map((r) => r.id), ['p-1'],
    'the impostor must not surface');
  assert.equal(store.get('p-2'), null, 'and it is not readable under its own name');
  assert.equal(store.get('p-1').title, '真身', 'the real record is intact');
  assert.ok(existsSync(join(dir, 'p-2.corrupt.json')), 'impostor quarantined');
  // 冒名者若被采信，list() 会吐出两个 'p-1'，clear() 于是删两遍、报两个数
  assert.equal(store.clearAll(), 1, 'the impostor is not counted as a record');
  assert.equal(store.get('p-1'), null, 'the real record was cleared, once');
});

// 临时文件不是历史：既不进列表，也不被 sweep 顺手删掉（它可能是
// 另一个进程正在写的）。
test('a stale .json.tmp is ignored by list() and left alone by sweep()', (t) => {
  const { dir, store } = tmpStore(t, { ttlMs: 1000 });
  store.save(base({ id: 'p-1', lastUsed: 1 }));
  writeFileSync(join(dir, 'p-1.json.tmp'), '{ half-written');
  assert.deepEqual(store.list({}).map((r) => r.id), ['p-1'], 'the tmp is not a record');
  assert.deepEqual(store.sweep(Date.now()), ['p-1'], 'the expired record still goes');
  assert.ok(existsSync(join(dir, 'p-1.json.tmp')), 'the tmp file is left alone');
});

// 网关与适配器各写各的字段：不能互相抹掉。
test('save() merges per field: the two writers do not erase each other', (t) => {
  const { store } = tmpStore(t);
  // 网关那一侧：配置 + 消息
  store.save(base({
    id: 'sid', adapter: 'pi', agent: 'pi', provider: 'zai', model: 'glm-4.7-flash',
    cwd: '/tmp/x', toolTier: 'full', title: '写一个贪吃蛇',
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
  }));
  const first = store.get('sid');
  // 适配器那一侧：只带自己知道的字段
  store.save({
    id: 'sid', adapter: 'cc', agent: 'cc',
    configDir: '/tmp/x/.cc', ccSessionId: 'cli-1',
  });
  const merged = store.get('sid');
  assert.equal(merged.provider, 'zai', 'the gateway fields survive');
  assert.equal(merged.model, 'glm-4.7-flash');
  assert.equal(merged.toolTier, 'full');
  assert.equal(merged.title, '写一个贪吃蛇');
  assert.equal(merged.messages.length, 1, 'the transcript survives');
  assert.equal(merged.adapter, 'cc', 'the adapter fields win');
  assert.equal(merged.ccSessionId, 'cli-1');
  assert.equal(merged.configDir, '/tmp/x/.cc');
  assert.equal(merged.createdAt, first.createdAt, 'createdAt still unchanged');
});

test('save() keeps a null field as an explicit value', (t) => {
  const { store } = tmpStore(t);
  store.save(base({ id: 'sid', piSessionId: 'pi-1' }));
  store.save({ id: 'sid', piSessionId: null });
  assert.equal(store.get('sid').piSessionId, null,
    'null means "explicitly no value", not "not given"');
});

test('companionDir() gives the cc config dir, and refuses a bad id', (t) => {
  const { dir, store } = tmpStore(t);
  assert.equal(store.companionDir('sess-1'), join(dir, 'sess-1.cc'));
  assert.equal(store.companionDir('../x'), null, 'a traversal id gets no path');
  assert.equal(store.companionDir('a/b'), null);
});

test('remove() also deletes a config dir that lives outside the companion path', (t) => {
  const { store } = tmpStore(t);
  const elsewhere = mkdtempSync(join(tmpdir(), 'atbx-cc-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  store.save({ id: 'cc-1', adapter: 'cc', agent: 'cc', configDir: elsewhere, ccSessionId: 'x' });
  store.remove('cc-1');
  assert.equal(existsSync(elsewhere), false, 'the config dir went with the record');
});

test('remove() survives a bogus configDir', (t) => {
  const { store } = tmpStore(t);
  store.save({ id: 'cc-2', adapter: 'cc', agent: 'cc', configDir: '/nonexistent/nope' });
  assert.doesNotThrow(() => store.remove('cc-2'));
  assert.equal(store.get('cc-2'), null, 'the record itself is gone');
});

// 记录文件是能被人手写的：它的 configDir 不能让 rmSync 指向任意路径。
// 「不该删的目标」要放在 store 目录与系统临时目录之外——放在 $HOME 下一个
// 一次性的空目录里：即便护栏失效，被删的也只是这个刚建的空目录。
test('remove() will not delete a configDir outside the store and tmp roots', (t) => {
  const outside = mkdtempSync(join(homedir(), 'atbx-precious-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const { store } = tmpStore(t);
  store.save({ id: 'cc-3', adapter: 'cc', agent: 'cc', configDir: outside });
  store.remove('cc-3');
  assert.ok(existsSync(outside), 'a hand-written path must not be rm -rf’d');
});

test('clear() needs a filter; clearAll() is the full wipe', (t) => {
  const { store } = tmpStore(t);
  store.save(base({ id: 'a', cwd: '/tmp/x' }));
  store.save(base({ id: 'b', cwd: '/tmp/y' }));
  assert.throws(() => store.clear({}), TypeError, 'an empty filter is not allowed');
  assert.throws(() => store.clear(), TypeError);
  assert.equal(store.clear({ cwd: '/tmp/x' }), 1, 'only the matching scope');
  assert.equal(store.get('a'), null);
  assert.equal(store.get('b')?.id, 'b', 'other cwd untouched');
  assert.equal(store.clearAll(), 1, 'the CLI wipe takes the rest');
  assert.equal(store.get('b'), null);
});

test('the store rejects a nonsense ttlMs', (t) => {
  const { dir } = tmpStore(t);
  assert.throws(() => new TranscriptStore({ dir, ttlMs: NaN }), TypeError);
  assert.throws(() => new TranscriptStore({ dir, ttlMs: -1 }), TypeError);
  assert.throws(() => new TranscriptStore({ dir, ttlMs: '7d' }), TypeError);
  assert.doesNotThrow(() => new TranscriptStore({ dir, ttlMs: 0 }));
});

// 错误消息里的 id 要截断：它可能是个很大的对象，整个塞进异常文本
// 会把日志冲垮。
test('an unsafe id is reported truncated', (t) => {
  const { store } = tmpStore(t);
  try {
    store.save(base({ id: 'x'.repeat(500) }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof TypeError);
    assert.ok(err.message.length < 100, `message must be short, got: ${err.message}`);
  }
});
