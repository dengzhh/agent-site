#!/usr/bin/env node
// agenttoolbox-agent — AgentToolbox 本地智能体桥。仅回环监听。
import { createModels } from '@earendil-works/pi-ai';
import { startServer } from '../src/server.mjs';
import { VERSION } from '../src/version.mjs';
import { loadConfig, grantDir, revokeDir, DEFAULT_CONFIG_PATH } from '../src/config.mjs';

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

const models = createModels();
const srv = await startServer({ port, allowedOrigins, models });
console.log(`agenttoolbox-agent v${VERSION} listening on http://127.0.0.1:${srv.port}`);
console.log(`allowed origins: ${allowedOrigins.join(', ')}`);
