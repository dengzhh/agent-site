import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confine, makeReadFile, makeListDir, makeGrep, MAX_GREP_MATCHES } from '../src/adapters/pi-tools.mjs';

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
