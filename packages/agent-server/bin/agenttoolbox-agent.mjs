#!/usr/bin/env node
// agenttoolbox-agent — AgentToolbox 本地智能体桥。仅回环监听。
import { createModels } from '@earendil-works/pi-ai';
import { startServer } from '../src/server.mjs';
import { VERSION } from '../src/version.mjs';

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
