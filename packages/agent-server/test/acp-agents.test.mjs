import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACP_AGENTS, getAgentDef, listAgentIds } from '../src/adapters/acp-agents.mjs';

test('agent table covers the five ACP agents', () => {
  assert.deepEqual(listAgentIds().sort(), ['codex', 'dsh', 'hermes', 'openclaw', 'opencode']);
});

test('each definition has a command and an isolation env factory', () => {
  for (const id of listAgentIds()) {
    const d = getAgentDef(id);
    assert.equal(typeof d.cmd, 'string', `${id}: cmd`);
    assert.ok(Array.isArray(d.args), `${id}: args`);
    assert.equal(typeof d.isolateEnv, 'function', `${id}: isolateEnv`);
    assert.equal(typeof d.name, 'string', `${id}: name`);
  }
});

test('isolateEnv points config at the given dir, never the user home', () => {
  const dir = '/tmp/atbx-test-home';
  for (const id of listAgentIds()) {
    const env = getAgentDef(id).isolateEnv(dir);
    const vals = Object.values(env);
    assert.ok(vals.some((v) => v === dir), `${id}: one env var must equal the given dir`);
    for (const v of vals) assert.doesNotMatch(String(v), /\/\.(hermes|openclaw|codex|dsh|config)/);
  }
});

test('unknown agent id returns undefined', () => {
  assert.equal(getAgentDef('nope'), undefined);
});

test('codex and dsh use npx so they need no global install', () => {
  assert.equal(getAgentDef('codex').cmd, 'npx');
  assert.equal(getAgentDef('dsh').cmd, 'npx');
});
