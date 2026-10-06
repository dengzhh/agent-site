import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, grantDir, revokeDir } from '../src/config.mjs';

const cfgPath = () => join(mkdtempSync(join(tmpdir(), 'atbx-cfg-')), 'config.json');

test('starts empty and grants dirs idempotently', () => {
  const p = cfgPath();
  assert.deepEqual(loadConfig(p).grantedDirs, []);
  grantDir('/tmp/proj-a', p);
  grantDir('/tmp/proj-a', p);
  grantDir('/tmp/proj-b', p);
  assert.deepEqual(loadConfig(p).grantedDirs, ['/tmp/proj-a', '/tmp/proj-b']);
});

test('grant returns the full list', () => {
  const p = cfgPath();
  grantDir('/tmp/a', p);
  assert.deepEqual(grantDir('/tmp/b', p), ['/tmp/a', '/tmp/b']);
});

test('revoke removes and tolerates missing', () => {
  const p = cfgPath();
  grantDir('/tmp/a', p);
  revokeDir('/tmp/a', p);
  revokeDir('/tmp/never', p);
  assert.deepEqual(loadConfig(p).grantedDirs, []);
});

test('corrupt file falls back to empty config', () => {
  const p = cfgPath();
  writeFileSync(p, '{ broken');
  assert.deepEqual(loadConfig(p).grantedDirs, []);
});

test('creates parent directories as needed', () => {
  const nested = join(mkdtempSync(join(tmpdir(), 'atbx-cfg-')), 'a', 'b', 'config.json');
  grantDir('/tmp/x', nested);
  assert.deepEqual(loadConfig(nested).grantedDirs, ['/tmp/x']);
});
