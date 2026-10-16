#!/usr/bin/env node
// 假 ACP agent：回放固定交互，供适配器测试，不依赖任何真实 agent。
// 环境变量 FAKE_ACP_MODE: ok（默认）| error
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_ACP_MODE ?? 'ok';
const rl = createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: 'fake-acp-session' } });
  } else if (method === 'session/prompt') {
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
