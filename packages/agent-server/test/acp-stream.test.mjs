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

// 应答 optionId 解析决策表（fail-closed）：
//  - 只认 *_once 的 kind：once = 每次都问，永不让 agent「记住」（选 *_always 等
//    于替用户点「允许并记住」，后续同类操作永久绕过抽屉）
//  - 家族内没有 once 项（只给了 *_always）→ null（适配器应答 cancelled）
//  - options 缺失 / 空 / kind 缺失或违规 → null
//  - 只按 kind 解析；name 不可信，绝不做关键词兜底
test('resolveOutcomeOptionIds prefers the *_once option within each family regardless of order', () => {
  const options = [
    { optionId: 'yes_once', name: 'Sure', kind: 'allow_once' },
    { optionId: 'no_way', name: 'Nah', kind: 'reject_once' },
  ];
  assert.deepEqual(resolveOutcomeOptionIds(options), { allowId: 'yes_once', rejectId: 'no_way' });
  // 审查回归：agent 把 allow_always 排在最前，也不得选它
  const ordered = [
    { optionId: 'always-a', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'once-a', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always-r', name: 'Always reject', kind: 'reject_always' },
    { optionId: 'once-r', name: 'Reject', kind: 'reject_once' },
  ];
  assert.deepEqual(resolveOutcomeOptionIds(ordered), { allowId: 'once-a', rejectId: 'once-r' });
  assert.deepEqual(resolveOutcomeOptionIds([...ordered].reverse()), { allowId: 'once-a', rejectId: 'once-r' });
});

test('resolveOutcomeOptionIds returns null for a family that only offers *_always', () => {
  // 只有 allow_always：选它 = 自动放行未来 → 应答 cancelled（agent 视为未选择）
  assert.deepEqual(
    resolveOutcomeOptionIds([
      { optionId: 'remember', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ]),
    { allowId: null, rejectId: 'no' },
  );
  // 对称：reject 家族只有 *_always 同样取消（「永远拒绝」也不是用户点过的承诺）
  assert.deepEqual(
    resolveOutcomeOptionIds([
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'never', name: 'Always reject', kind: 'reject_always' },
    ]),
    { allowId: 'yes', rejectId: null },
  );
});

test('resolveOutcomeOptionIds returns null when options are absent or unrecognized', () => {
  assert.deepEqual(resolveOutcomeOptionIds([]), { allowId: null, rejectId: null });
  assert.deepEqual(resolveOutcomeOptionIds(undefined), { allowId: null, rejectId: null });
  assert.deepEqual(resolveOutcomeOptionIds('junk'), { allowId: null, rejectId: null });
});

test('resolveOutcomeOptionIds resolves strictly by kind, never by option name', () => {
  // deny 决策不靠名字：旧 name 兜底的 /no/i 会命中 "Notify me and proceed"，
  // 把拒绝答到放行项上（fail-open）
  assert.deepEqual(
    resolveOutcomeOptionIds([
      { optionId: 'notify', name: 'Notify me and proceed', kind: 'allow_once' },
      { optionId: 'decline', name: 'Proceed without me', kind: 'reject_once' },
    ]),
    { allowId: 'notify', rejectId: 'decline' },
  );
  // kind 缺失（违规 agent，schema 必填）→ 取消，绝不按名字猜
  assert.deepEqual(
    resolveOutcomeOptionIds([{ optionId: 'ok', name: 'Approve it' }, { optionId: 'stop', name: 'Deny it' }]),
    { allowId: null, rejectId: null },
  );
});

// 歧义防御（fail-closed）：options 由 agent 提供，可能畸形或恶意。
//  - 同一家族出现多个 *_once 条目（optionId 相同与否不论）→ 该家族 null：
//    Array.find 只会静默取第一个，畸形 agent 可借此把抽屉决策答到非预期项上；
//    宁可应答 cancelled（用户未选择）也不猜。
//  - allowId 与 rejectId 解析到同一个 optionId → 两者都 null：
//    放行/拒绝应答不可区分，等于把决策权交回 agent。
test('resolveOutcomeOptionIds fails closed when a family offers multiple *_once candidates', () => {
  // 两个 allow_once：无法确定用户点的是哪一个 → allowId 取消，reject 照常
  assert.deepEqual(
    resolveOutcomeOptionIds([
      { optionId: 'allow-a', name: 'Allow', kind: 'allow_once' },
      { optionId: 'allow-b', name: 'Allow more', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ]),
    { allowId: null, rejectId: 'no' },
  );
  // 对称：reject 家族重复同样取消
  assert.deepEqual(
    resolveOutcomeOptionIds([
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny-a', name: 'Deny', kind: 'reject_once' },
      { optionId: 'deny-b', name: 'Never mind', kind: 'reject_once' },
    ]),
    { allowId: 'yes', rejectId: null },
  );
  // 同 optionId 的重复条目同样算歧义：规则按条目数计，不为 id 相等豁免
  assert.deepEqual(
    resolveOutcomeOptionIds([
      { optionId: 'dup', name: 'Allow', kind: 'allow_once' },
      { optionId: 'dup', name: 'Allow', kind: 'allow_once' },
    ]),
    { allowId: null, rejectId: null },
  );
});

test('resolveOutcomeOptionIds fails closed when allow and reject resolve to the same optionId', () => {
  // 畸形 agent 让两个家族指到同一 optionId：应答 allow 还是 deny 对它不可区分
  assert.deepEqual(
    resolveOutcomeOptionIds([
      { optionId: 'one', name: 'Allow', kind: 'allow_once' },
      { optionId: 'one', name: 'Reject', kind: 'reject_once' },
    ]),
    { allowId: null, rejectId: null },
  );
});
