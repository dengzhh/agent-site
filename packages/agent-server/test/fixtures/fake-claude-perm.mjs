#!/usr/bin/env node
// 假 CC（权限回合）：在回合中点发出 control_request(can_use_tool)，等待 stdin 上的
// control_response，再按答复走不同结局——驱动 cc 适配器权限桥的测试。
// 环境变量：FAKE_PERM_ID（request_id，默认 perm-1）、FAKE_PERM_TOOL（工具名，默认 Bash）、
// FAKE_PERM_INPUT（input JSON，默认 {"command":"rm -rf /tmp/x"}）。
// stdout 回放：
//   RESP=<原始 control_response 行>  —— 供测试断言线上帧的精确形状
//   allowed / denied                 —— 按 behavior 给出的结论
// 15s 等不到应答或 stdin 提前关闭 → error result（防回归时套件挂死）。
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

for await (const line of createInterface({ input: process.stdin })) {
  // 忽略 user 消息等无关行：只认 control_response
  if (!line.includes('"type":"control_response"')) continue;
  clearTimeout(timer);
  // 原样回显应答行：测试据此断言适配器写出的线上帧精确形状
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `RESP=${line}` } } });
  let behavior = 'malformed';
  try { behavior = JSON.parse(line)?.response?.response?.behavior ?? 'malformed'; } catch { /* 保持 malformed */ }
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: behavior === 'allow' ? 'allowed' : 'denied' } } });
  out({ type: 'result', subtype: 'success', session_id: sess, is_error: false, result: behavior });
  process.exit(0);
}
clearTimeout(timer);
out({ type: 'result', subtype: 'error_during_execution', session_id: sess, is_error: true, result: 'stdin closed before control_response' });
process.exit(8);
