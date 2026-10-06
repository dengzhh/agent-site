// 起一个 cc turn 并长期挂住不结束，用于验证「网关进程被终止时 cc 子进程不留孤儿」。
// 用法: node cc-turn-holder.mjs <cliPath> <pidfile>
// 该进程扮演「网关」，被 SIGTERM 时应当清理掉它派生的 cli 子进程。
import { createCcAdapter } from '../../src/adapters/cc.mjs';

const [cliPath, pidFile] = process.argv.slice(2);
const cc = createCcAdapter({ cliPath, env: { FAKE_PIDFILE: pidFile } });
// 挂住：夹具不会自行退出，只有 kill 才会结束。
for await (const _ of cc.run({
  messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
  baseUrl: 'https://x/api', cwd: '/tmp', allowedTools: [],
})) { /* hold the turn open */ }
