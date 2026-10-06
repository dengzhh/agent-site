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

// ── 子进程生命周期 ────────────────────────────────────────────────────────────
// 子进程一律以 detached 启动：它因此自成进程组（组长 pid = child.pid），于是
// process.kill(-pid) 能一次击杀「CLI + 它自己派生的孙进程」。只杀直接子进程是不够的——
// CLI 是 node 程序，会再拉子进程，那些孙子进程会被 reparent 到 init 变成孤儿。
// 所有关闭路径（正常收尾 / 生成器提前 return / abort / 网关收到 SIGTERM·SIGINT）
// 都必须走 killTree。
const liveChildren = new Set();
// 已建出、尚未回收的隔离目录。进程被信号终止时 process.exit() 会跳过生成器的
// finally，目录就没人收了——所以全局兜底也要负责扫掉它们。
const liveConfigDirs = new Set();
const KILL_GRACE_MS = 5000;

function killTree(child, sig) {
  if (!child || !child.pid) return;
  // 已退出：kill 无意义（且 pid 可能已被复用，误杀他人）。
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, sig); // 负 pid = 整个进程组
  } catch {
    // 进程组不可用（子进程已消失 / 非 detached）时退回单进程 kill。
    try { child.kill(sig); } catch { /* 已退出，忽略 */ }
  }
}

// 先 SIGTERM 给宽限期，到期仍存活再升级 SIGKILL；返回定时器供清理。
function terminate(child) {
  killTree(child, 'SIGTERM');
  const t = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
  t.unref(); // 清理定时器不应拖住事件循环
  return t;
}

// 同步清理：只做同步操作（process.kill / rmSync 都是同步的），'exit' 阶段可用。
function sweepSync(sig) {
  for (const c of liveChildren) killTree(c, sig);
  for (const d of liveConfigDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
}

let globalCleanupInstalled = false;
// 全局兜底：只在确实起了子进程后才挂载，避免「导入模块即产生全局副作用」。
// ⚠️ process.on('SIGTERM'/'SIGINT') 会顶掉 Node 的默认终止行为，所以处理器里
// 必须自己退出——否则网关会变成「收到 SIGTERM 却赖着不死」，比孤儿更糟。
function installGlobalCleanup() {
  if (globalCleanupInstalled) return;
  globalCleanupInstalled = true;
  process.on('exit', () => sweepSync('SIGKILL'));
  for (const [sig, code] of [['SIGTERM', 15], ['SIGINT', 2]]) {
    if (process.listenerCount(sig) > 0) continue; // 已被宿主接管，不越权覆盖
    process.on(sig, () => {
      sweepSync('SIGTERM');
      process.exit(128 + code);
    });
  }
}

export function createCcAdapter({ cliPath = 'claude', env = {} } = {}) {
  return {
    id: 'cc',
    async available() {
      if (cliPath.includes('/')) return existsSync(cliPath);
      const paths = (process.env.PATH ?? '').split(':');
      return paths.some((p) => p && existsSync(join(p, cliPath)));
    },
    async *run({ messages, model, apiKey, baseUrl, cwd, allowedTools = [], resumeSessionId, signal }) {
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
          detached: true, // 自成进程组，供 killTree(-pid) 整组清理（stdout/stderr 仍是管道）
        });
      } catch (err) {
        // 同步 spawn 失败（参数非法等）：目录已建好，必须回收，否则泄漏。
        rmSync(configDir, { recursive: true, force: true });
        yield { type: 'error', message: `failed to spawn claude: ${err.message}` };
        return;
      }

      liveChildren.add(child);
      liveConfigDirs.add(configDir);
      installGlobalCleanup();

      // abort（/abort 路由或客户端断连）→ 立即 SIGTERM 整个进程组，宽限期后升级 SIGKILL。
      // 监听器挂在 signal 上而非只依赖下面的 finally：生成器可能正挂在 yield 上
      // 等消费者来取，此时 finally 不会执行，但 abort 必须立刻生效。
      let escalate = null;
      let aborted = false;
      const onAbort = () => {
        if (aborted) return;
        aborted = true;
        if (escalate) clearTimeout(escalate);
        escalate = terminate(child);
      };
      if (signal) {
        // signal 可能在 spawn 之前就已 abort（客户端秒断）：此时 event 不会再触发，须立即处理。
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      // spawn 的失败大多是**异步**上报的：cliPath 不存在时（二进制被删、路径错，
      // 或调用方绕过 available() 直接 run()）会在下一个 tick emit 'error'（ENOENT）。
      // 不监听就是 unhandled 'error'，直接杀掉整个宿主进程，而不是让 run() 失败。
      // 这里转成一个正常的 error 事件，与事件契约一致。
      let spawnError = null;
      child.on('error', (err) => { spawnError = err; });
      // 关闭信息在起手就登记：晚一点再 once('close') 可能挂在一个已经触发过的
      // 事件上、永久等不到（子进程早于我们注册就已退出的竞态）。
      let closed = null;
      // 只有真正 close 了才移出 liveChildren：这样进程退出兜底钩子能覆盖到
      // 「已发 SIGTERM 但尚未死透」的窗口，不留缝隙。
      child.on('close', (code, sig) => { closed = { code, sig }; liveChildren.delete(child); });
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
            if (!closed) await new Promise((r) => child.once('close', () => r()));
            // abort 导致的终止不是异常：显式标记，便于上层区分「用户取消」与「CLI 崩溃」。
            if (aborted) yield { type: 'error', message: 'claude aborted', aborted: true };
            else yield { type: 'error', message: `claude exited with code ${closed?.code}` };
          }
        }
      } finally {
        // 生成器被提前 return()（调用方 break）或抛错时，子进程仍可能活着——
        // 一个 turn 可能跑几十秒，不清理就变成孤儿进程。正常结束时进程已退出，
        // killTree 会因 exitCode 非空直接返回（幂等）。目录同此一次性回收。
        if (escalate) clearTimeout(escalate);
        if (signal) signal.removeEventListener('abort', onAbort);
        // 不在这里 delete(liveChildren)：交给 'close' 回调，避免「已发信号但未死透」
        // 期间从进程退出兜底钩子的视野里消失（见上面 close 监听）。
        terminate(child); // SIGTERM + 宽限后 SIGKILL，保证最终一定死
        rmSync(configDir, { recursive: true, force: true });
        liveConfigDirs.delete(configDir);
      }
    },
  };
}
