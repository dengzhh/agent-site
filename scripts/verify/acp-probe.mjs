// 一次性验证 v2：用 ClientSideConnection 直连形态驱动 agent，并正确接住流式文本。
// 用法：node acp-probe.mjs <cmd> [...args]
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('usage: node acp-probe.mjs <cmd> [...args]'); process.exit(1); }

const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write('[agent] ' + d));
child.on('exit', (c, s) => console.log(`\n[child exited code=${c} sig=${s}]`));

const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
);

const chunks = [];
let conn;

// ClientSideConnection 的 client 接口：实现 ACP 要求客户端提供的方法
const client = {
  async requestPermission(req) {
    // 无头环境：自动放行一次性权限（安全边界由 grant 机制在上层控制）
    console.log('[perm requested]', JSON.stringify(req?.toolCall?.title ?? req).slice(0, 120));
    return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
  },
  async sessionUpdate(params) {
    const u = params?.update ?? params;
    if (u?.sessionUpdate === 'agent_message_chunk') {
      const t = u.content?.text ?? '';
      if (t) { chunks.push(t); process.stdout.write(t); }
    } else if (u?.sessionUpdate) {
      console.log(`\n[update: ${u.sessionUpdate}]`);
    }
  },
  async readTextFile() { throw new Error('not supported'); },
  async writeTextFile() { throw new Error('not supported'); },
};

try {
  conn = new acp.ClientSideConnection((_agent) => client, stream);
  const init = await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
  console.log('INIT ok. caps:', JSON.stringify(init.agentCapabilities ?? {}));

  const s = await conn.newSession({ cwd: process.cwd(), mcpServers: [] });
  console.log('SESSION:', s.sessionId);

  const r = await conn.prompt({
    sessionId: s.sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly: PONG' }],
  });
  console.log('\nPROMPT done. stopReason:', r?.stopReason);
} catch (e) {
  console.error('\nERROR:', e?.message ?? e);
}

child.kill();
console.log('TEXT:', JSON.stringify(chunks.join('')));
