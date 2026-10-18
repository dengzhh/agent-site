#!/usr/bin/env node
// 假 ACP agent：回放固定交互，供适配器测试，不依赖任何真实 agent。
// 环境变量 FAKE_ACP_MODE: ok（默认）| error
// 追加参数 --perm-req <title>：在 session/prompt 期间向客户端发出一个真正的
// session/request_permission 请求（id 99），把客户端所选 optionId 以
// `PERM: <optionId>` delta 回显后再 end_turn —— 用来驱动适配器的权限应答逻辑。
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_ACP_MODE ?? 'ok';
const argv = process.argv.slice(2);
const permIdx = argv.indexOf('--perm-req');
const permTitle = permIdx >= 0 ? argv[permIdx + 1] : undefined;
const sid = permTitle !== undefined ? 'fake-acp-perm' : 'fake-acp-session';
const rl = createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// --perm-req 模式下挂起的 session/prompt 请求 id：权限往返完成后才应答它。
let pendingPromptId;

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  // 客户端对 id 99 的应答（response 没有 method，必须先于兜底分支判断）：
  // 回显所选 optionId，再收尾挂起的 prompt。
  if (id === 99 && method === undefined) {
    const optionId = msg.result?.outcome?.optionId ?? 'unknown';
    send({ jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `PERM: ${optionId}` } } } });
    if (pendingPromptId !== undefined) {
      send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'end_turn' } });
      pendingPromptId = undefined;
    }
    return;
  }

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: sid } });
  } else if (method === 'session/prompt') {
    if (permTitle !== undefined) {
      // 以真正的 JSON-RPC 请求（而非通知）发出权限询问，等 id 99 的应答。
      // 注意 toolCallId 必填（SDK 会校验入参，缺了直接回 -32602）。
      pendingPromptId = id;
      send({ jsonrpc: '2.0', id: 99, method: 'session/request_permission',
        params: { sessionId: params?.sessionId ?? sid, toolCall: { toolCallId: 'perm-1', title: permTitle },
          options: [
            { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ] } });
      return;
    }
    const sid = params?.sessionId;
    if (mode === 'error') {
      send({ jsonrpc: '2.0', id, result: { stopReason: 'error' } });
      return;
    }
    send({ jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } } } });
    send({ jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } } } });
    // 真实 ACP 形状：{used, size, cost}（上下文窗口用量），不是 {inputTokens,outputTokens}
    send({ jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 5, size: 200000 } } });
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
});
