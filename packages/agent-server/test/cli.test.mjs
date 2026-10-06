import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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
