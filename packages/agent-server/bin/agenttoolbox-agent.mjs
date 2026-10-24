#!/usr/bin/env node
// agenttoolbox-agent — AgentToolbox 本地智能体桥。仅回环监听。
import { createModels } from '@earendil-works/pi-ai';
import { startServer } from '../src/server.mjs';
import { VERSION } from '../src/version.mjs';
import { TranscriptStore } from '../src/transcripts.mjs';
import { loadConfig, grantDir, revokeDir, DEFAULT_CONFIG_PATH, sessionStoreDir, sessionTtlMs } from '../src/config.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// CLI 子命令：grant / list / revoke。浏览器无法提供本地路径，故授权只能由终端发起。
// 必须在 --port 解析之前处理（子命令是本进程的一次性动作，不启动服务器）。
const CONFIG_PATH = process.env.ATBX_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
const sub = process.argv[2];

if (sub === 'grant') {
  const dir = process.argv[3];
  if (!dir) { console.error('usage: agenttoolbox-agent grant <dir>'); process.exit(1); }
  const dirs = grantDir(dir, CONFIG_PATH);
  console.log(`granted: ${dir}`);
  console.log(`all granted dirs: ${dirs.join(', ') || '(none)'}`);
  process.exit(0);
}
if (sub === 'revoke') {
  const dir = process.argv[3];
  if (!dir) { console.error('usage: agenttoolbox-agent revoke <dir>'); process.exit(1); }
  revokeDir(dir, CONFIG_PATH);
  console.log(`revoked: ${dir}`);
  process.exit(0);
}
if (sub === 'list') {
  const { grantedDirs } = loadConfig(CONFIG_PATH);
  console.log(grantedDirs.length ? grantedDirs.join('\n') : '(no granted dirs)');
  process.exit(0);
}

if (sub === 'sessions') {
  // 会话历史的终端管理。安全边界：
  // - list 只输出元数据（id/时间/agent/cwd/标题），绝不打印消息文本——转录里可能有
  //   文件内容、命令输出、截图引用，甚至敏感串，不适合直接倒进终端。
  // - clearAll 是"清光所有历史"的终局操作（web UI 只能清当前目录范围），故必须 --yes。
  const action = process.argv[3];
  const dir = sessionStoreDir();
  if (action === 'list') {
    // list() 本身按 lastUsed 降序（newest first），直接沿用。
    const rows = new TranscriptStore({ dir, ttlMs: sessionTtlMs() }).list({});
    if (!rows.length) { console.log('(no sessions)'); process.exit(0); }
    for (const r of rows) {
      const when = new Date(r.lastUsed).toISOString().slice(0, 16).replace('T', ' ');
      console.log(`${r.id}  ${when}  ${r.agent}  ${r.cwd ?? '-'}  ${r.title ?? ''}`);
    }
    process.exit(0);
  }
  if (action === 'clear') {
    if (!process.argv.slice(4).includes('--yes')) {
      console.error('refusing to clear without --yes (this deletes every session transcript)');
      process.exit(1);
    }
    const n = new TranscriptStore({ dir, ttlMs: sessionTtlMs() }).clearAll();
    console.log(`cleared ${n} session(s)`);
    process.exit(0);
  }
  console.error('usage: agenttoolbox-agent sessions <list|clear --yes>');
  process.exit(1);
}

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : Number(process.env.PORT ?? 31415);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('invalid --port'); process.exit(1);
}
if (args.includes('--host') || args.includes('-H')) {
  // MVP 安全边界：禁止非回环监听（spec Security 节）
  console.error('agenttoolbox-agent binds to 127.0.0.1 only; --host is not supported');
  process.exit(1);
}

const allowedOrigins = [
  'https://dengzhh.github.io',
  ...(process.env.AGENT_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
];

// 本地 claude 的 home。缺省 ~/.claude；尊重用户自己设的 CLAUDE_CONFIG_DIR
// （有些人的 claude 装在别处）。**只读目录项，不解析 transcript 内容**。
function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

const models = createModels();
// localCcRoot：本地 claude 的 home，让网页 chat 看得见用户在本机终端里聊的会话
// （见 cc.mjs 的 adoptLocalCcSession）。**必须在这里显式给**——startServer 的
// 缺省是不导入，因为缺省读 ~/.claude 会让测试也去扫开发者真实的会话数据。
// 这个值是本进程唯一一次「我要读用户本地 claude 历史」的声明，写在明处。
const srv = await startServer({ port, allowedOrigins, models, localCcRoot: claudeHome() });
console.log(`agenttoolbox-agent v${VERSION} listening on http://127.0.0.1:${srv.port}`);
console.log(`allowed origins: ${allowedOrigins.join(', ')}`);
console.log(`logging requests/turns to this console${process.env.ATBX_VERBOSE === '1' ? ' (+ agent stderr, verbose)' : ' (set ATBX_VERBOSE=1 for agent stderr)'}`);
