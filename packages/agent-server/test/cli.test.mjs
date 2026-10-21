import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { TranscriptStore } from '../src/transcripts.mjs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agenttoolbox-agent.mjs');
const cfg = () => join(mkdtempSync(join(tmpdir(), 'atbx-cli-')), 'c.json');
const run = (args, cfgPath) =>
  execFileSync('node', [BIN, ...args], { encoding: 'utf8', env: { ...process.env, ATBX_CONFIG_PATH: cfgPath } });

test('grant then list shows the dir', () => {
  const p = cfg();
  run(['grant', '/tmp/demo-proj'], p);
  assert.match(run(['list'], p), /\/tmp\/demo-proj/);
});

test('revoke removes it', () => {
  const p = cfg();
  run(['grant', '/tmp/x'], p);
  run(['revoke', '/tmp/x'], p);
  assert.doesNotMatch(run(['list'], p), /\/tmp\/x/);
});

test('grant without argument exits non-zero', () => {
  const p = cfg();
  assert.throws(() => run(['grant'], p));
});

test('list with no grants says so', () => {
  const p = cfg();
  assert.match(run(['list'], p), /no granted dirs/i);
});

const execFileP = promisify(execFile);
// 与 execFileSync 版 run 不同：失败不抛，返回 { code, out }（exit code + stdout/stderr 合并）。
const runCode = async (args, env) => {
  try {
    const { stdout } = await execFileP('node', [BIN, ...args], { encoding: 'utf8', env });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
};

test('sessions list prints history and clear removes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cli-'));
  try {
    const store = new TranscriptStore({ dir });
    store.save({ id: 'cli-1', agent: 'pi', cwd: '/tmp/x', provider: 'faux', model: 'faux', title: '甲', messages: [{ role: 'user', content: 'sk-LEAK' }] });
    store.save({ id: 'cli-2', agent: 'pi', cwd: '/tmp/y', provider: 'faux', model: 'faux', title: '乙' });
    const env = { ...process.env, ATBX_SESSION_DIR: dir, ATBX_CONFIG_PATH: join(dir, 'config.json') };
    const listed = await runCode(['sessions', 'list'], env);
    assert.equal(listed.code, 0);
    assert.match(listed.out, /cli-1/);
    assert.match(listed.out, /甲/);
    // 安全：绝不打印消息内容
    assert.doesNotMatch(listed.out, /sk-LEAK/);
    const cleared = await runCode(['sessions', 'clear', '--yes'], env);
    assert.equal(cleared.code, 0);
    assert.equal(store.get('cli-1'), null);
    assert.equal(store.get('cli-2'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sessions clear without --yes exits non-zero and keeps records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cli-'));
  try {
    const store = new TranscriptStore({ dir });
    store.save({ id: 'cli-keep', agent: 'pi', cwd: '/tmp/x', provider: 'faux', model: 'faux', title: '留' });
    const env = { ...process.env, ATBX_SESSION_DIR: dir, ATBX_CONFIG_PATH: join(dir, 'config.json') };
    const res = await runCode(['sessions', 'clear'], env);
    assert.notEqual(res.code, 0);
    assert.ok(store.get('cli-keep'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sessions list on empty dir prints placeholder and exits 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cli-'));
  try {
    const env = { ...process.env, ATBX_SESSION_DIR: dir, ATBX_CONFIG_PATH: join(dir, 'config.json') };
    const res = await runCode(['sessions', 'list'], env);
    assert.equal(res.code, 0);
    assert.match(res.out, /\(no sessions\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
