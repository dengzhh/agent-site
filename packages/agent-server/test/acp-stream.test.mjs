import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSessionUpdate, describePermission, resolveOutcomeOptionIds } from '../src/adapters/acp-stream.mjs';

test('agent_message_chunk becomes a delta', () => {
  const p = { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } } };
  assert.deepEqual(mapSessionUpdate(p), [{ type: 'delta', text: 'PONG' }]);
});

test('agent_thought_chunk becomes a thinking event', () => {
  const p = { sessionId: 's', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } };
  assert.deepEqual(mapSessionUpdate(p), [{ type: 'thinking', text: 'hmm' }]);
});

test('usage_update carries context-window usage, not streamed as text', () => {
  // 真实 ACP 形状（见 SDK schema zUsageUpdate）：{used, size, cost?}
  const p = { sessionId: 's', update: { sessionUpdate: 'usage_update', used: 10, size: 200000 } };
  const out = mapSessionUpdate(p);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'usage');
  assert.deepEqual(out[0].usage, { used: 10, size: 200000, cost: undefined });
});

test('tool_call updates are surfaced as activity, not text', () => {
  const p = { sessionId: 's', update: { sessionUpdate: 'tool_call', title: 'Read file' } };
  const out = mapSessionUpdate(p);
  assert.equal(out[0].type, 'activity');
  assert.equal(out[0].title, 'Read file');
});

test('unknown update kinds yield no events', () => {
  assert.deepEqual(mapSessionUpdate({ update: { sessionUpdate: 'plan' } }), []);
  assert.deepEqual(mapSessionUpdate({}), []);
  assert.deepEqual(mapSessionUpdate(null), []);
});

test('empty or missing text is skipped', () => {
  assert.deepEqual(mapSessionUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { text: '' } } }), []);
  assert.deepEqual(mapSessionUpdate({ update: { sessionUpdate: 'agent_message_chunk' } }), []);
});

// ── request_permission 转发映射（Task 12）────────────────────────────────────

test('describePermission prefers kind for the action and keeps a one-line summary', () => {
  assert.deepEqual(
    describePermission({ toolCallId: 't', title: 'Write pkg.json', kind: 'edit' }),
    { action: 'edit', summary: 'Write pkg.json (edit)' },
  );
  // title 已含 kind 词时不重复（'search' 命中 title 内的词）
  assert.deepEqual(
    describePermission({ title: 'Search code for TODO', kind: 'search' }),
    { action: 'search', summary: 'Search code for TODO' },
  );
  // 缺 kind → action 退回 title；缺 title → 退回 kind；两者皆缺 → 'tool'
  assert.deepEqual(describePermission({ title: 'Run tests' }), { action: 'Run tests', summary: 'Run tests' });
  assert.deepEqual(describePermission({ kind: 'execute' }), { action: 'execute', summary: 'execute' });
  assert.deepEqual(describePermission(null), { action: 'tool', summary: 'tool' });
});

test('describePermission caps the summary at 160 chars', () => {
  const { summary } = describePermission({ title: 'x'.repeat(300), kind: 'write' });
  assert.ok(summary.length <= 160, `summary length ${summary.length}`);
  assert.ok(summary.endsWith('...'));
});

test('resolveOutcomeOptionIds reads the request options, not hardcoded ids', () => {
  const req = { options: [
    { optionId: 'yes_once', name: 'Sure', kind: 'allow_once' },
    { optionId: 'no_way', name: 'Nah', kind: 'reject_once' },
  ] };
  assert.deepEqual(resolveOutcomeOptionIds(req.options), { allowId: 'yes_once', rejectId: 'no_way' });
  // 标准 id 照常解析；allow_always/reject_always 同样命中语义前缀
  assert.deepEqual(
    resolveOutcomeOptionIds([{ optionId: 'a', name: 'A', kind: 'allow_always' }, { optionId: 'r', name: 'R', kind: 'reject_always' }]),
    { allowId: 'a', rejectId: 'r' },
  );
  // kind 缺失时退回 name 关键词，最后回退标准字面量
  assert.deepEqual(
    resolveOutcomeOptionIds([{ optionId: 'ok', name: 'Approve it' }, { optionId: 'stop', name: 'Deny it' }]),
    { allowId: 'ok', rejectId: 'stop' },
  );
  assert.deepEqual(resolveOutcomeOptionIds([]), { allowId: 'allow_once', rejectId: 'reject_once' });
  assert.deepEqual(resolveOutcomeOptionIds(undefined), { allowId: 'allow_once', rejectId: 'reject_once' });
});
