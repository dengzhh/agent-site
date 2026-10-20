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

test('node ids are 12 hex chars — the chain silently corrupts on collision, so spend the entropy', () => {
  const lines = buildPiSessionLines({
    piSessionId: '01abc', cwd: '/tmp/x',
    messages: [msg('user', [{ type: 'text', text: 'a' }])],
  });
  for (const id of [lines[1].id, lines[2].id]) {
    assert.match(id, /^[0-9a-f]{12}$/);
  }
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
  // deepEqual 而非只看 input：usage 必须是「原样照抄」，被改写/包装过的也算错
  assert.deepEqual(lines[2].message.usage, { input: 1, output: 2 });
  assert.equal(lines[2].message.stopReason, 'stop');
  // undefined 也可能是「有这个键但值是 undefined」：断言键根本不存在
  assert.equal('usage' in lines[3].message, false, 'absent meta stays absent — do not invent fields');
  assert.equal('stopReason' in lines[3].message, false);
});

test('optional fields are copied, not aliased — later mutation of the transcript must not leak in', () => {
  const content = [{ type: 'text', text: 'a' }];
  const usage = { input: 1 };
  const lines = buildPiSessionLines({
    piSessionId: '01abc', cwd: '/tmp/x', name: 'n',
    messages: [{ role: 'assistant', content, usage, timestamp: 1 }],
  });
  content.push({ type: 'text', text: 'injected' });
  usage.output = 999;
  assert.equal(lines[2].message.content.length, 1, 'content is a copy');
  assert.deepEqual(lines[2].message.usage, { input: 1 }, 'usage is a copy');
});

test('message payload timestamp is coerced to epoch-ms: non-numeric input falls back to now', () => {
  // 实测本机真实会话文件：事件行 timestamp 是 ISO 字符串，message 载荷里的
  // timestamp 是 epoch 毫秒数字（见 ~/.pi/agent/sessions 下的 .jsonl）。
  // transcript 里若混进了 ISO 字符串，不能原样带出去。
  for (const bad of ['2026-08-27T11:09:30.853Z', null, undefined]) {
    const before = Date.now();
    const lines = buildPiSessionLines({
      piSessionId: '01abc', cwd: '/tmp/x', name: 'n',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }], timestamp: bad }],
    });
    const ts = lines[2].message.timestamp;
    assert.equal(typeof ts, 'number', `timestamp ${JSON.stringify(bad)} must be coerced to a number`);
    assert.ok(ts >= before && ts <= Date.now() + 1000, 'fallback must be a plausible epoch-ms value');
  }
});

test('numeric message timestamp passes through as epoch-ms', () => {
  const lines = buildPiSessionLines({
    piSessionId: '01abc', cwd: '/tmp/x', name: 'n',
    messages: [msg('user', [{ type: 'text', text: 'a' }], 1787828970852)],
  });
  assert.equal(lines[2].message.timestamp, 1787828970852);
});

test('blank name falls back to the default; a non-string name is a TypeError', () => {
  for (const name of [undefined, null, '', '   ']) {
    const lines = buildPiSessionLines({ piSessionId: '01abc', cwd: '/tmp/x', name });
    assert.equal(lines[1].name, 'AgentToolbox', `name=${JSON.stringify(name)} falls back`);
  }
  const named = buildPiSessionLines({ piSessionId: '01abc', cwd: '/tmp/x', name: 'x' });
  assert.equal(named[1].name, 'x', 'a real name is kept as-is');
  assert.throws(() => buildPiSessionLines({ piSessionId: '01abc', cwd: '/tmp/x', name: 42 }), TypeError);
  assert.throws(() => buildPiSessionLines({ piSessionId: '01abc', cwd: '/tmp/x', name: {} }), TypeError);
});

test('throws TypeError on missing/empty piSessionId or cwd, naming the field and the value', () => {
  assert.throws(() => buildPiSessionLines({ cwd: '/tmp/x' }), /piSessionId/);
  assert.throws(() => buildPiSessionLines({ piSessionId: '01abc' }), /cwd/);
  assert.throws(() => buildPiSessionLines({ piSessionId: '', cwd: '/tmp/x' }), /piSessionId/);
  assert.throws(() => buildPiSessionLines({ piSessionId: '01abc', cwd: '' }), /cwd/);
  assert.throws(() => buildPiSessionLines({ piSessionId: 42, cwd: '/tmp/x' }), /42/, 'the offending value appears in the message');
});

test('throws TypeError when messages is not an array', () => {
  assert.throws(() => buildPiSessionLines({ piSessionId: '01abc', cwd: '/tmp/x', messages: 'nope' }), TypeError);
  assert.throws(() => buildPiSessionLines({ piSessionId: '01abc', cwd: '/tmp/x', messages: {} }), TypeError);
  // messages 缺省是合法的（当作空 transcript）
  assert.doesNotThrow(() => buildPiSessionLines({ piSessionId: '01abc', cwd: '/tmp/x' }));
});

test('throws TypeError naming field and index for malformed messages', () => {
  const opts = (messages) => ({ piSessionId: '01abc', cwd: '/tmp/x', messages });
  // null / undefined 直接躺在数组里，也要带索引——裸的 "reading 'role'" 没法定位
  assert.throws(() => buildPiSessionLines(opts([null])), /messages\[0\]/);
  assert.throws(() => buildPiSessionLines(opts([undefined])), /messages\[0\]/);
  assert.throws(() => buildPiSessionLines(opts([msg('user', []), 7])), /messages\[1\]/);
  assert.throws(() => buildPiSessionLines(opts([{ role: 'user', timestamp: 1 }])), /messages\[0\]\.content/);
  assert.throws(() => buildPiSessionLines(opts([msg('user', 'hi')])), /messages\[0\]\.content must be an array/);
  assert.throws(() => buildPiSessionLines(opts([{ content: [], timestamp: 1 }])), /messages\[0\]\.role/);
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

test('renderPiSession: empty array renders as empty string; garbage elements are TypeErrors', () => {
  assert.equal(renderPiSession([]), '', 'an empty file is "", not a bare newline');
  // 今天 null/undefined 会序列化成字面量 "undefined" 行——对逐行读取的 CLI 是毒
  assert.throws(() => renderPiSession([{ type: 'session' }, null]), TypeError);
  assert.throws(() => renderPiSession([undefined]), TypeError);
  assert.throws(() => renderPiSession(['nope']), TypeError);
});
