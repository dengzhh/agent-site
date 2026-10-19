import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confine, confineForWrite, makeReadFile, makeListDir, makeGrep, makeWriteFile, makeBash, fullTools, MAX_GREP_MATCHES } from '../src/adapters/pi-tools.mjs';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tools-'));
  writeFileSync(join(dir, 'README.md'), '# hello\nworld\n');
  writeFileSync(join(dir, 'app.ts'), 'const x = 42;\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'util.ts'), 'export const y = 1;\n');
  return dir;
}

test('confine resolves inside cwd and blocks traversal', () => {
  const dir = sandbox();
  assert.equal(confine(dir, 'README.md'), join(dir, 'README.md'));
  assert.throws(() => confine(dir, '../outside'), /escapes working directory/);
  assert.throws(() => confine(dir, '/etc/passwd'), /escapes working directory/);
  rmSync(dir, { recursive: true, force: true });
});

test('read_file returns text content', async () => {
  const dir = sandbox();
  const tool = makeReadFile(dir);
  const r = await tool.execute('id1', { path: 'README.md' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /# hello/);
  rmSync(dir, { recursive: true, force: true });
});

test('read_file blocks traversal as tool error', async () => {
  const dir = sandbox();
  const tool = makeReadFile(dir);
  const r = await tool.execute('id1', { path: '../../../etc/passwd' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /escapes working directory/);
  rmSync(dir, { recursive: true, force: true });
});

test('list_dir lists entries with dir suffix', async () => {
  const dir = sandbox();
  const tool = makeListDir(dir);
  const r = await tool.execute('id1', { path: '' });
  const lines = r.content[0].text.split('\n').sort();
  assert.deepEqual(lines, ['README.md', 'app.ts', 'src/']);
  rmSync(dir, { recursive: true, force: true });
});

test('grep searches recursively, skips node_modules and caps matches', async () => {
  const dir = sandbox();
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'x.ts'), 'const x = 42;\n');
  const tool = makeGrep(dir);
  // pattern 用 'const'：app.ts 与 src/util.ts 各命中一行（'const x' 只能命中 app.ts，
  // 断言的「app.ts + src/util.ts」两行就凑不齐了）
  const r = await tool.execute('id1', { pattern: 'const', include: '.ts' });
  const lines = r.content[0].text.split('\n');
  assert.ok(lines.every((l) => !l.includes('node_modules')), 'skips node_modules');
  assert.equal(lines.length, 2, 'app.ts + src/util.ts');
  rmSync(dir, { recursive: true, force: true });
});

test('symlinked file inside cwd that resolves outside is blocked', async () => {
  const dir = sandbox();
  try { symlinkSync('/etc/passwd', join(dir, 'evil')); } catch { /* 权限不足时跳过 */ }
  const tool = makeReadFile(dir);
  const r = await tool.execute('id1', { path: 'evil' });
  assert.equal(r.isError, true, 'symlink escape denied');
  rmSync(dir, { recursive: true, force: true });
});

test('read_file error message does not leak the absolute cwd path', async () => {
  const dir = sandbox();
  const tool = makeReadFile(dir);
  const r = await tool.execute('id1', { path: 'missing.txt' });
  assert.equal(r.isError, true);
  assert.ok(!r.content[0].text.includes(dir), 'no absolute cwd in error text');
  rmSync(dir, { recursive: true, force: true });
});

test('grep caps matches at MAX_GREP_MATCHES', async () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'many.txt'), Array.from({ length: MAX_GREP_MATCHES + 10 }, (_, i) => `hit ${i}`).join('\n'));
  const tool = makeGrep(dir);
  const r = await tool.execute('id1', { pattern: 'hit' });
  const lines = r.content[0].text.split('\n');
  assert.equal(lines.length, MAX_GREP_MATCHES + 1, '50 matches + 截断提示');
  assert.match(lines[lines.length - 1], /结果截断/);
  rmSync(dir, { recursive: true, force: true });
});

test('grep hardening: long pattern truncated, catastrophic regex bounded by time budget', async () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'a.txt'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  const tool = makeGrep(dir);
  // 超长 pattern → 截断到 200 字符后正常执行（不抛、不挂）
  const long = await tool.execute('id1', { pattern: 'a'.repeat(300) });
  assert.equal(typeof long.content[0].text, 'string');
  // 灾难性回溯 pattern（(a+)+$ 对纯 a 行是 O(2^n)）——时间预算 + 单行截断保证不卡死
  const t1 = Date.now();
  const evil = await tool.execute('id2', { pattern: '(a+)+$' });
  const elapsed = Date.now() - t1;
  assert.ok(elapsed < 8000, `grep returned in ${elapsed}ms (budget-bounded)`);
  assert.equal(typeof evil.content?.[0]?.text, 'string');
  rmSync(dir, { recursive: true, force: true });
});

// ── 期 2：写/执行工具（write_file / bash）——每个动作先过 requestApproval 审批闸 ──

// 记录型审批函数：push({action, summary}) 后返回 allow
const recorder = (allow, log = []) => async (action, summary) => { log.push({ action, summary }); return allow; };

test('confineForWrite allows new files but blocks traversal and symlink escapes', () => {
  const dir = sandbox();
  symlinkSync('/etc/hosts', join(dir, 'evil-link'));       // 目标是外指符号链接
  mkdirSync(join(dir, 'outer'));
  symlinkSync('/etc', join(dir, 'outer-dir-link'));        // 父目录链上有外指链接

  assert.equal(confineForWrite(dir, 'src/new.txt'), join(dir, 'src', 'new.txt'), 'new file in existing dir');
  assert.throws(() => confineForWrite(dir, '../outside.txt'), /escapes working directory/);
  assert.throws(() => confineForWrite(dir, '/etc/hosts'), /escapes working directory/);
  assert.throws(() => confineForWrite(dir, 'evil-link'), /escapes working directory/, 'write would follow the link out');
  assert.throws(() => confineForWrite(dir, 'outer-dir-link/x'), /escapes working directory/, 'symlinked parent blocked');
  rmSync(dir, { recursive: true, force: true });
});

test('write_file creates a file when approved, preview carries path and size', async () => {
  const dir = sandbox();
  const log = [];
  const tool = makeWriteFile(dir, recorder(true, log));
  const r = await tool.execute('id1', { path: 'src/new.txt', content: 'hello write\n' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /wrote src\/new\.txt/);
  assert.equal(readFileSync(join(dir, 'src', 'new.txt'), 'utf8'), 'hello write\n');
  assert.deepEqual(log, [{ action: 'write', summary: 'write_file src/new.txt (12 bytes)' }]);
  rmSync(dir, { recursive: true, force: true });
});

test('write_file deny returns isError "denied by user" and leaves the file untouched', async () => {
  const dir = sandbox();
  const tool = makeWriteFile(dir, recorder(false));
  const r = await tool.execute('id1', { path: 'README.md', content: 'overwritten!' });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'denied by user');
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), '# hello\nworld\n', 'existing file untouched');
  rmSync(dir, { recursive: true, force: true });
});

test('write_file refuses payloads over 1MB before prompting', async () => {
  const dir = sandbox();
  const log = [];
  const tool = makeWriteFile(dir, recorder(true, log));
  const r = await tool.execute('id1', { path: 'big.txt', content: 'x'.repeat(1024 * 1024 + 1) });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /too large/);
  assert.equal(log.length, 0, 'oversized writes never reach the approval drawer');
  rmSync(dir, { recursive: true, force: true });
});

test('write_file blocks traversal without prompting the user', async () => {
  const dir = sandbox();
  const log = [];
  const tool = makeWriteFile(dir, recorder(true, log));
  const r = await tool.execute('id1', { path: '../escape.txt', content: 'nope' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /escapes working directory/);
  assert.equal(log.length, 0, 'invalid paths must not open the drawer');
  rmSync(dir, { recursive: true, force: true });
});

test('bash runs an approved command and captures stdout', async () => {
  const dir = sandbox();
  const log = [];
  const tool = makeBash(dir, recorder(true, log));
  const r = await tool.execute('id1', { command: `node -e "process.stdout.write('ok')"` });
  assert.equal(r.isError, undefined);
  assert.equal(r.content[0].text, 'ok');
  assert.deepEqual(log, [{ action: 'bash', summary: `node -e "process.stdout.write('ok')"` }]);
  rmSync(dir, { recursive: true, force: true });
});

test('bash deny returns isError "denied by user" and never executes', async () => {
  const dir = sandbox();
  const tool = makeBash(dir, recorder(false));
  const r = await tool.execute('id1', { command: 'echo hi > created-by-bash.txt' });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'denied by user');
  assert.equal(existsSync(join(dir, 'created-by-bash.txt')), false, 'denied command must not run');
  rmSync(dir, { recursive: true, force: true });
});

test('bash combines stderr and reports non-zero exit codes in text', async () => {
  const dir = sandbox();
  const tool = makeBash(dir, recorder(true));
  const r = await tool.execute('id1', { command: 'echo out; echo err >&2; exit 3' });
  // 非零退出码是命令自身的领域输出（不是工具故障）：正常结果 + exit 前缀，与只读
  // 工具把 fs 错误转 isError 的语义区分开（bash 不存在/超时这类环境故障才 isError）。
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /^exit 3\n/);
  assert.match(r.content[0].text, /out/);
  assert.match(r.content[0].text, /err/);
  rmSync(dir, { recursive: true, force: true });
});

test('bash output is truncated to 8KB', async () => {
  const dir = sandbox();
  const tool = makeBash(dir, recorder(true));
  const r = await tool.execute('id1', { command: `node -e "process.stdout.write('x'.repeat(20000))"` });
  assert.equal(r.isError, undefined);
  assert.ok(r.content[0].text.length < 9000, `got ${r.content[0].text.length} chars`);
  assert.match(r.content[0].text, /截断/);
  rmSync(dir, { recursive: true, force: true });
});

test('bash commands that overrun the timeout come back as tool errors', async () => {
  const dir = sandbox();
  const tool = makeBash(dir, recorder(true), { timeoutMs: 250 });
  const t0 = Date.now();
  const r = await tool.execute('id1', { command: 'while :; do :; done' });   // 纯 builtin 忙循环，无孤儿进程
  const elapsed = Date.now() - t0;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /timed out/);
  assert.ok(elapsed < 5000, `killed promptly (${elapsed}ms)`);
  rmSync(dir, { recursive: true, force: true });
});

test('bash rejects empty commands without prompting', async () => {
  const dir = sandbox();
  const log = [];
  const tool = makeBash(dir, recorder(true, log));
  const r = await tool.execute('id1', { command: '   ' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /command required/);
  assert.equal(log.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

// ── 复审修复：悬空符号链接逃逸 / 进程组清理 / maxBuffer / 预览截断 / 必填校验 ──

// pgrep/pkill 助手：用唯一标记（如不常见的 sleep 时长）定位测试拉起的进程，
// 断言无孤儿 + 失败路径上也清理干净（绝不给宿主机留下 30s 的 sleep）
function pgrepCount(pattern) {
  try {
    const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).length;
  } catch {
    return 0;   // pgrep 退出码 1 = 无匹配
  }
}
function pkillPattern(pattern) {
  try { execFileSync('pkill', ['-f', pattern]); } catch { /* 无匹配即目标状态 */ }
}

test('write_file blocks dangling symlinks pointing outside cwd (end-to-end escape)', async () => {
  const dir = sandbox();
  // 目标父目录存在、目标文件不存在：dangling link 的 realpath 抛 ENOENT，与
  // 「真正的新文件」不可区分——旧实现据此放行，fs.writeFile 跟随链接在 cwd 外落盘。
  const outsideDir = join(tmpdir(), `pi-tools-outside-${process.pid}`);
  mkdirSync(outsideDir, { recursive: true });
  const outsideTarget = join(outsideDir, 'pwned.txt');
  try {
    symlinkSync(outsideTarget, join(dir, 'dangler'));
    const log = [];
    const tool = makeWriteFile(dir, recorder(true, log));
    const r = await tool.execute('id1', { path: 'dangler', content: 'pwned' });
    assert.equal(r.isError, true, 'dangling symlink write must be rejected');
    assert.match(r.content[0].text, /escapes working directory/);
    assert.equal(log.length, 0, 'escape attempts must not open the approval drawer');
    assert.equal(existsSync(outsideTarget), false, 'nothing may be written outside cwd');
    // existsSync 会跟随链接（dangling 恒 false），断言链接本体要 lstat
    assert.equal(lstatSync(join(dir, 'dangler')).isSymbolicLink(), true, 'the symlink itself is left alone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('confineForWrite rejects symlink loops instead of surfacing raw ELOOP', () => {
  const dir = sandbox();
  symlinkSync('loop', join(dir, 'loop'));
  assert.throws(() => confineForWrite(dir, 'loop'), /escapes working directory/);
  rmSync(dir, { recursive: true, force: true });
});

test('write_file still writes genuinely new files and existing regular files', async () => {
  const dir = sandbox();
  const tool = makeWriteFile(dir, recorder(true));
  const fresh = await tool.execute('id1', { path: 'brand-new.txt', content: 'a' });
  assert.equal(fresh.isError, undefined);
  assert.equal(readFileSync(join(dir, 'brand-new.txt'), 'utf8'), 'a');
  const overwrite = await tool.execute('id2', { path: 'brand-new.txt', content: 'b' });
  assert.equal(overwrite.isError, undefined, 'existing regular file stays writable');
  assert.equal(readFileSync(join(dir, 'brand-new.txt'), 'utf8'), 'b');
  rmSync(dir, { recursive: true, force: true });
});

test('write_file rejects a missing content without prompting', async () => {
  const dir = sandbox();
  const log = [];
  const tool = makeWriteFile(dir, recorder(true, log));
  const r = await tool.execute('id1', { path: 'no-content.txt' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /content required/);
  assert.equal(log.length, 0, 'invalid requests must not open the drawer');
  assert.equal(existsSync(join(dir, 'no-content.txt')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('bash timeout kills the whole process group (no orphaned grandchildren)', async () => {
  const dir = sandbox();
  const marker = 'sleep 30.371';   // 唯一时长做 pgrep 标记，不误伤无关进程
  try {
    const tool = makeBash(dir, recorder(true), { timeoutMs: 300 });
    const r = await tool.execute('id1', { command: `${marker} & echo spawned; wait` });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /timed out/);
    // SIGKILL 生效有毫秒级延迟：轮询最多 ~2s，确认后台 sleep 已随进程组一起死
    let orphans = -1;
    for (let i = 0; i < 20; i++) {
      orphans = pgrepCount(marker);
      if (orphans === 0) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal(orphans, 0, 'backgrounded sleep must die with the process group');
  } finally {
    pkillPattern(marker);   // 断言失败也不能留下孤儿
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bash timeout SIGKILLs the group so SIGTERM-immune commands cannot hang the tool', async () => {
  const dir = sandbox();
  const tool = makeBash(dir, recorder(true), { timeoutMs: 300 });
  const t0 = Date.now();
  const r = await tool.execute('id1', { command: `trap '' TERM; while :; do :; done` });
  const elapsed = Date.now() - t0;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /timed out/);
  assert.ok(elapsed < 2000, `SIGKILL escalation returned in ${elapsed}ms (no hang)`);
  rmSync(dir, { recursive: true, force: true });
});

test('bash returns partial output as a normal result when stdout exceeds the 1MB cap', async () => {
  const dir = sandbox();
  const tool = makeBash(dir, recorder(true));
  const r = await tool.execute('id1', { command: `node -e "process.stdout.write('x'.repeat(2*1024*1024))"` });
  assert.equal(r.isError, undefined, 'buffer overrun is domain output, not a tool failure');
  assert.match(r.content[0].text, /x{100,}/, 'partial stdout is preserved');
  assert.match(r.content[0].text, /超限/);
  assert.match(r.content[0].text, /1MB/);
  assert.ok(r.content[0].text.length < 9000, `still truncated to 8KB (got ${r.content[0].text.length})`);
  rmSync(dir, { recursive: true, force: true });
});

test('bash approval preview appends "(+N chars)" when truncated', async () => {
  const dir = sandbox();
  const log = [];
  const tool = makeBash(dir, recorder(true, log));
  const cmd = `echo ${'a'.repeat(300)}`;   // 305 字符
  const r = await tool.execute('id1', { command: cmd });
  assert.equal(r.isError, undefined);
  assert.equal(log.length, 1);
  assert.equal(log[0].summary, `${cmd.slice(0, 200)}… (+105 chars)`, 'preview keeps 200 chars plus a truncation marker');
  rmSync(dir, { recursive: true, force: true });
});

test('fullTools = read trio + write_file + bash, approval wired into both', async () => {
  const dir = sandbox();
  const tools = fullTools(dir, recorder(true));
  assert.deepEqual(tools.map((tool) => tool.name), ['read_file', 'list_dir', 'grep', 'write_file', 'bash']);
  const write = tools.find((tool) => tool.name === 'write_file');
  const r = await write.execute('id1', { path: 'via-full.txt', content: 'y' });
  assert.equal(r.isError, undefined);
  assert.equal(readFileSync(join(dir, 'via-full.txt'), 'utf8'), 'y');
  rmSync(dir, { recursive: true, force: true });
});
