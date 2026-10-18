#!/usr/bin/env node
// 假 CC（权限回合）：在回合中点发出 control_request(can_use_tool)，等待 stdin 上的
// control_response，再按答复走不同结局——驱动 cc 适配器权限桥的测试。
// 环境变量：FAKE_PERM_ID（request_id，默认 perm-1）、FAKE_PERM_TOOL（工具名，默认 Bash）、
// FAKE_PERM_INPUT（input JSON，默认 {"command":"rm -rf /tmp/x"}）。
// stdout 回放：
//   RESP=<原始 control_response 行>  —— 供测试断言线上帧的精确形状
//   allowed / denied                 —— 按 behavior 给出的结论
// 15s 等不到应答或 stdin 提前关闭 → error result（防回归时套件挂死）。
// FAKE_CLAUDE_STAY=1：复刻真实 CLI（2.1.302 实测）的收尾行为——发完 result 不退出，
// 而是握着 stdin 继续存活，直到 stdin EOF（再过 ~400ms 模拟收尾）才 exit 0。
// 默认夹具的立即 process.exit(0) 会掩盖「适配器不在 result 处 end stdin」的挂死缺陷。
import { createInterface } from 'node:readline';

const sess = 'fake-perm-sess-1';
const reqId = process.env.FAKE_PERM_ID ?? 'perm-1';
const toolName = process.env.FAKE_PERM_TOOL ?? 'Bash';
let toolInput = { command: 'rm -rf /tmp/x' };
try { toolInput = JSON.parse(process.env.FAKE_PERM_INPUT ?? '') ?? toolInput; } catch { /* 用默认 */ }

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

out({ type: 'system', subtype: 'init', session_id: sess });
out({
  type: 'control_request',
  request_id: reqId,
  request: {
    subtype: 'can_use_tool',
    tool_name: toolName,
    input: toolInput,
    tool_use_id: 'tu-1',
    permission_suggestions: [],
  },
});

let timer = setTimeout(() => {
  out({ type: 'result', subtype: 'error_during_execution', session_id: sess, is_error: true, result: 'fixture timeout waiting for control_response' });
  process.exit(9);
}, 15000);
timer.unref();

let answered = false;
for await (const line of createInterface({ input: process.stdin })) {
  // 忽略 user 消息等无关行：只认 control_response
  if (!line.includes('"type":"control_response"')) continue;
  clearTimeout(timer);
  answered = true;
  // 原样回显应答行：测试据此断言适配器写出的线上帧精确形状
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `RESP=${line}` } } });
  let behavior = 'malformed';
  try { behavior = JSON.parse(line)?.response?.response?.behavior ?? 'malformed'; } catch { /* 保持 malformed */ }
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: behavior === 'allow' ? 'allowed' : 'denied' } } });
  out({ type: 'result', subtype: 'success', session_id: sess, is_error: false, result: behavior });
  break;
}
clearTimeout(timer);
if (!answered) {
  out({ type: 'result', subtype: 'error_during_execution', session_id: sess, is_error: true, result: 'stdin closed before control_response' });
  process.exit(8);
}
// FAKE_CLAUDE_STAY=1：result 已发但不退场——先挂上 stdin EOF 监听再睡 ~400ms（模拟
// 收尾开销），EOF 到了才 exit 0。适配器若不在 result 行处 end stdin，这里就永远等不到。
if (process.env.FAKE_CLAUDE_STAY === '1') {
  const stdinEnded = new Promise((r) => { process.stdin.once('end', r); process.stdin.once('close', r); });
  await new Promise((r) => setTimeout(r, 400));
  await stdinEnded;
}
process.exit(0);
