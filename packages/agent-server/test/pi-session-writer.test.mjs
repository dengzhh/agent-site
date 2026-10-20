import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPiSessionLines, renderPiSession } from '../src/pi-session-writer.mjs';

const msg = (role, content, ts = 1) => ({ role, content, timestamp: ts });

test('first three lines are session / session_info / first message, chained by parentId', () => {
  const lines = buildPiSessionLines({
    piSessionId: '01abc',
    cwd: '/tmp/x',
    name: '写一个贪吃蛇',
    messages: [msg('user', [{ type: 'text', text: 'hi' }]), msg('assistant', [{ type: 'text', text: 'yo' }])],
  });
  assert.equal(lines[0].type, 'session');
  assert.equal(lines[0].version, 3, 'pi CLI 的 session 行 version 是 3');
  assert.equal(lines[0].id, '01abc');
  assert.equal(lines[0].cwd, '/tmp/x', 'cwd 必须原样保留——CLI 靠它判断是否同 project');

  assert.equal(lines[1].type, 'session_info');
  assert.equal(lines[1].name, '写一个贪吃蛇');
  assert.equal(lines[1].parentId, null, 'session_info 是链头之后的第一条');

  assert.equal(lines[2].type, 'message');
  assert.equal(lines[2].message.role, 'user');
  assert.equal(lines[2].parentId, lines[1].id, 'message 链接到 session_info');

  assert.equal(lines[3].type, 'message');
  assert.equal(lines[3].message.role, 'assistant');
  assert.equal(lines[3].parentId, lines[2].id, '每条都链接到上一条，形成链');
});

test('every line carries a unique id and an ISO timestamp', () => {
  const lines = buildPiSessionLines({
    piSessionId: '01abc', cwd: '/tmp/x', name: 'n',
    messages: [msg('user', [{ type: 'text', text: 'a' }]), msg('assistant', [{ type: 'text', text: 'b' }]), msg('user', [{ type: 'text', text: 'c' }])],
  });
  const ids = lines.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  for (const l of lines) assert.match(l.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('image blocks are copied verbatim — base64 must survive', () => {
  const img = { type: 'image', data: 'iVBORw0KGgoAAAANS', mimeType: 'image/png' };
  const lines = buildPiSessionLines({
    piSessionId: '01abc', cwd: '/tmp/x', name: 'n',
    messages: [msg('user', [{ type: 'text', text: '看图' }, img])],
  });
  const content = lines[2].message.content;
  assert.deepEqual(content[1], img, 'image block passes through untouched');
});

test('assistant messages keep usage/stopReason when present and omit when absent', () => {
  const lines = buildPiSessionLines({
    piSessionId: '01abc', cwd: '/tmp/x', name: 'n',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 2 }, stopReason: 'stop', timestamp: 1 },
      msg('assistant', [{ type: 'text', text: 'no meta' }]),
    ],
  });
  assert.equal(lines[2].message.usage.input, 1);
  assert.equal(lines[2].message.stopReason, 'stop');
  assert.equal(lines[3].message.usage, undefined, 'absent meta stays absent — do not invent fields');
});

test('empty transcript still produces a valid header pair', () => {
  const lines = buildPiSessionLines({ piSessionId: '01abc', cwd: '/tmp/x', name: 'n', messages: [] });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'session');
  assert.equal(lines[1].type, 'session_info');
});

test('message payload timestamp mirrors real pi files: epoch-ms number on the payload, ISO on the event line', () => {
  // 实测本机真实会话文件：事件行 timestamp 是 ISO 字符串，message 载荷里的
  // timestamp 是 epoch 毫秒数字（见 ~/.pi/agent/sessions 下的 .jsonl）。
  const lines = buildPiSessionLines({
    piSessionId: '01abc', cwd: '/tmp/x', name: 'n',
    messages: [msg('user', [{ type: 'text', text: 'a' }], 1787828970852)],
  });
  assert.equal(typeof lines[2].timestamp, 'string');
  assert.equal(lines[2].message.timestamp, 1787828970852);
  assert.equal(typeof lines[2].message.timestamp, 'number');
});

test('message payload timestamp falls back to current epoch-ms when absent', () => {
  const before = Date.now();
  const lines = buildPiSessionLines({
    piSessionId: '01abc', cwd: '/tmp/x', name: 'n',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }],
  });
  const ts = lines[2].message.timestamp;
  assert.equal(typeof ts, 'number');
  assert.ok(ts >= before, 'fallback must be a plausible epoch-ms value');
});

test('blank name falls back to the default', () => {
  for (const name of [undefined, '', '   ']) {
    const lines = buildPiSessionLines({ piSessionId: '01abc', cwd: '/tmp/x', name });
    assert.equal(lines[1].name, 'AgentToolbox', `name=${JSON.stringify(name)} falls back`);
  }
  const named = buildPiSessionLines({ piSessionId: '01abc', cwd: '/tmp/x', name: 'x' });
  assert.equal(named[1].name, 'x', 'a real name is kept as-is');
});

test('throws TypeError on missing/empty piSessionId or cwd', () => {
  assert.throws(() => buildPiSessionLines({ cwd: '/tmp/x' }), TypeError);
  assert.throws(() => buildPiSessionLines({ piSessionId: '01abc' }), TypeError);
  assert.throws(() => buildPiSessionLines({ piSessionId: '', cwd: '/tmp/x' }), TypeError);
  assert.throws(() => buildPiSessionLines({ piSessionId: '01abc', cwd: '' }), TypeError);
});

test('throws TypeError when messages is not an array', () => {
  assert.throws(() => buildPiSessionLines({ piSessionId: '01abc', cwd: '/tmp/x', messages: 'nope' }), TypeError);
  assert.throws(() => buildPiSessionLines({ piSessionId: '01abc', cwd: '/tmp/x', messages: {} }), TypeError);
  // messages 缺省是合法的（当作空 transcript）
  assert.doesNotThrow(() => buildPiSessionLines({ piSessionId: '01abc', cwd: '/tmp/x' }));
});

test('renderPiSession emits one \\n-terminated JSON line per event, round-trip identical', () => {
  const img = { type: 'image', data: 'iVBORw0KGgoAAAANS', mimeType: 'image/png' };
  const lines = buildPiSessionLines({
    piSessionId: '01abc', cwd: '/tmp/x', name: 'n',
    messages: [msg('user', [{ type: 'text', text: '看图' }, img], 1787828970852), msg('assistant', [{ type: 'text', text: 'ok' }])],
  });
  const text = renderPiSession(lines);
  assert.ok(text.endsWith('\n'), 'output must end with a newline');
  const parsed = text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  assert.equal(parsed.length, lines.length, '3 lines in → exactly 3 newline-terminated lines');
  assert.deepEqual(parsed, lines, 'each line parses back to a deep-equal object');
  // base64 图片载荷经 JSON 序列化/反序列化后必须逐字节不变
  const roundImg = parsed[2].message.content[1];
  assert.equal(roundImg.data, img.data);
  assert.equal(roundImg.mimeType, img.mimeType);
});
