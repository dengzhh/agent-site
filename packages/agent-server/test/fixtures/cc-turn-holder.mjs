// 起一个带 sessionId 的 cc turn 并长期挂住不结束，用于验证「网关进程被
// SIGTERM 时，无 store 的后备 config dir 是否被误删」——目录归 fallbackDirs
// 所有，进程退出兜底应该删它（它跨不了进程，留着只会堆积）；而 R9 要求
// store 记录指向的目录不能被删。本夹具用于前者：不带 transcripts，
// SIGTERM 后目录应当消失。
// 用法: node cc-turn-holder.mjs <cliPath> <pidfile> <sessionId> [storeDir]
// 给了 storeDir 就挂一个 TranscriptStore（R9 正向用例），否则走 fallbackDirs。
import { createCcAdapter } from '../../src/adapters/cc.mjs';
import { TranscriptStore } from '../../src/transcripts.mjs';

const [cliPath, pidFile, sessionId, storeDir] = process.argv.slice(2);
const cc = createCcAdapter({
  cliPath,
  env: { FAKE_PIDFILE: pidFile },
  transcripts: storeDir ? new TranscriptStore({ dir: storeDir }) : null,
});
// 挂住：夹具不会自行退出，只有 kill 才会结束。
for await (const _ of cc.run({
  messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
  baseUrl: 'https://x/api', cwd: '/tmp', allowedTools: [], sessionId,
})) { /* hold the turn open */ }
