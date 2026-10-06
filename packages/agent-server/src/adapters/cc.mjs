// Claude Code 适配器：把 claude CLI 的 headless stream-json 转成统一事件流。
// 关键安全点：CLAUDE_CONFIG_DIR 指向临时空目录，阻止 CLI 加载用户的
// ~/.claude/settings.json（否则会用用户默认模型并执行其 hooks——已实测）。
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCcLine, isGateError } from './cc-stream.mjs';

function isolatedConfigDir() {
  return mkdtempSync(join(tmpdir(), 'atbx-cc-'));
}

function buildArgs({ allowedTools = [], resumeSessionId }) {
  const args = ['-p', '--output-format=stream-json', '--include-partial-messages', '--verbose'];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  args.push('--allowedTools', allowedTools.join(','));
  return args;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return String(messages[i].content ?? '');
  }
  return '';
}

export function createCcAdapter({ cliPath = 'claude', env = {} } = {}) {
  return {
    id: 'cc',
    async available() {
      if (cliPath.includes('/')) return existsSync(cliPath);
      const paths = (process.env.PATH ?? '').split(':');
      return paths.some((p) => p && existsSync(join(p, cliPath)));
    },
    async *run({ messages, model, apiKey, baseUrl, cwd, allowedTools = [], resumeSessionId }) {
      // 先在局部变量里建好隔离目录，finally 才能拿到引用清理——不能就地写进 env 里。
      const configDir = isolatedConfigDir();
      let child;
      try {
        child = spawn(cliPath, buildArgs({ allowedTools, resumeSessionId }), {
          cwd: cwd || process.cwd(),
          env: {
            ...process.env,
            ...env,
            CLAUDE_CONFIG_DIR: configDir,
            ANTHROPIC_BASE_URL: baseUrl,
            ANTHROPIC_AUTH_TOKEN: apiKey ?? '',
            ANTHROPIC_API_KEY: '',
            ANTHROPIC_MODEL: model,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        // 同步 spawn 失败（参数非法等）：目录已建好，必须回收，否则泄漏。
        rmSync(configDir, { recursive: true, force: true });
        yield { type: 'error', message: `failed to spawn claude: ${err.message}` };
        return;
      }

      // spawn 的失败大多是**异步**上报的：cliPath 不存在时（二进制被删、路径错，
      // 或调用方绕过 available() 直接 run()）会在下一个 tick emit 'error'（ENOENT）。
      // 不监听就是 unhandled 'error'，直接杀掉整个宿主进程，而不是让 run() 失败。
      // 这里转成一个正常的 error 事件，与事件契约一致。
      let spawnError = null;
      child.on('error', (err) => { spawnError = err; });
      // stderr 必须持续排空：'close' 要等全部 stdio 流关闭才触发。若 CLI 往
      // stderr 写满管道缓冲（>64KB）而我们不读，close 永不触发，下面的
      // 「缺终结事件」分支就会永久挂起。内容刻意不透出到事件里——避免任何
      // 可能的凭证回显进入上层日志。
      child.stderr.resume();
      // 子进程可能在消费 stdin 之前就退出（例如未读取 stdin 的 CLI / 启动即失败），
      // 此时管道已关闭，写入会抛 EPIPE。这是「prompt 送不到」而非适配器故障，
      // 真正的结论由 stdout 上的终结事件或退出码给出，因此这里显式吞掉写入错误——
      // 否则 unhandled 'error' 会直接炸掉测试进程。
      child.stdin.on('error', () => {});
      try {
        child.stdin.write(lastUserText(messages));
        child.stdin.end();
      } catch {
        // 同步 EPIPE（socket 已销毁）同样忽略，语义与上面的异步分支一致。
      }

      try {
        let buffer = '';
        let sawTerminal = false;
        for await (const chunk of child.stdout) {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const ev = parseCcLine(line.trim());
            if (!ev) continue;
            if (ev.type === 'error' && isGateError(ev.message)) ev.gate = true;
            if (ev.type === 'turn_end' || ev.type === 'error') sawTerminal = true;
            yield ev;
          }
        }
        const tail = parseCcLine(buffer.trim());
        if (tail) {
          if (tail.type === 'error' && isGateError(tail.message)) tail.gate = true;
          if (tail.type === 'turn_end' || tail.type === 'error') sawTerminal = true;
          yield tail;
        }
        if (!sawTerminal) {
          // spawn 从未成功起进程时不会有 'close'，此时绝不能等 close——那会挂死。
          if (spawnError) {
            yield { type: 'error', message: `failed to spawn claude: ${spawnError.message}` };
          } else {
            const code = await new Promise((r) => child.once('close', r));
            yield { type: 'error', message: `claude exited with code ${code}` };
          }
        }
      } finally {
        // 生成器被提前 return()（调用方 break）或抛错时，子进程仍可能活着——
        // 一个 turn 可能跑几十秒，不 kill 就变成孤儿进程。正常结束时进程已退出，
        // kill 是幂等的（对已退出进程为 no-op）。目录同此一次性回收。
        child.kill();
        rmSync(configDir, { recursive: true, force: true });
      }
    },
  };
}
