// Claude Code 适配器：把 claude CLI 的 headless stream-json 转成统一事件流。
// 关键安全点：CLAUDE_CONFIG_DIR 指向临时空目录，阻止 CLI 加载用户的
// ~/.claude/settings.json（否则会用用户默认模型并执行其 hooks——已实测）。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCcLine, isGateError, summarizeToolInput, buildControlResponse } from './cc-stream.mjs';
import { VERBOSE, logErr } from '../log.mjs';
import { sanitizeChildEnv } from '../child-env.mjs';

// ── 隔离配置目录的生存期：跟随 transcript 记录，不是跟随进程 ────────────────
// `claude --resume <id>` 只在 CLAUDE_CONFIG_DIR 里找 transcript
// （<dir>/projects/<cwd-slug>/<id>.jsonl）。目录每轮新建、回合结束即删，
// resume 必然失败——CLI 2.1.302 实测报 "No conversation found with session
// ID: …"，用户看到的就是「第 2 条消息立即报错」（2026-10-20 复现确认）。
// 修法是把目录的生存期绑到真正需要它的东西上：会话，并**记进 transcript
// 记录**（configDir 字段）。此前的内存 Map 版本在网关重启或 LRU 逐出后即忘，
// 下一轮照样 resume 失败；磁盘记录让目录跨进程存活，与历史本身同生共死
// （remove()/sweep() 删记录时一并回收目录）。只有没传 transcripts 的调用方
// （旧测试 / 一次性调用）维持旧行为：本轮自建自删，无主可记。

// 取本会话的隔离目录。返回 { dir, keep }：
//   keep = true  → 目录归会话所有（已记入或即将记入 transcript 记录）。调用方
//                  **不得**在单个 turn 结束时删它（下一轮 --resume 还要靠它）；
//                  回收只经由 transcript.remove()/sweep() / 进程退出兜底。
//   keep = false → 调用方没给 sessionId 或没传 store，没有归属，turn 结束就删。
function configDirFor(transcripts, sessionId) {
  if (transcripts && sessionId) {
    // 先看记录里有没有上次的目录。注意 mkdirSync(recursive) 会把被删掉的目录
    // **原样重建**而不是抛错，所以「目录还在吗」不能靠 mkdir 探测——要靠
    // 目录里有没有上次那个 transcript 文件。文件不在（目录被清/用户手删），
    // 旧 ccSessionId 就成了无源之水：拿着它 --resume 必然报
    // "No conversation found"。落到下面新建一个目录并清掉旧 id。
    const rec = transcripts.get(sessionId);
    if (rec?.configDir && rec.ccSessionId
      && findCcTranscript(rec.configDir, rec.ccSessionId)) {
      try {
        mkdirSync(rec.configDir, { recursive: true, mode: 0o700 });
        return { dir: rec.configDir, keep: true };
      } catch { /* 权限不对等：落到下面新建一个 */ }
    }
    const dir = transcripts.companionDir(sessionId);
    if (dir) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // 新目录立刻落盘，后续 restore() 才看得到一个真实存在的 dir。
      // ccSessionId 显式清成 null：走到这里要么是首轮，要么是旧目录/旧
      // transcript 没了——旧 id 留着的话 restore() 会拿它配一个空目录，
      // --resume 必然失败（"No conversation found"）。null 在 save 的逐字段
      // 合并里是显式清除。首个成功的 turn 结束前 restore() 返回 null。
      transcripts.save({ id: sessionId, configDir: dir, ccSessionId: null });
      return { dir, keep: true };
    }
    // id 不安全（不该发生：server 早已验过形状）——落到底下的无主分支。
  }
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-'));
  return { dir, keep: false };
}


function buildArgs({ allowedTools = [], resumeSessionId, streamInput = false }) {
  const args = ['-p', '--output-format=stream-json', '--include-partial-messages', '--verbose'];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  args.push('--allowedTools', allowedTools.join(','));
  // full 级别（Task 11）：工具调用逐个经抽屉审批。--permission-prompt-tool 是 CLI 唯一的
  // 权限路由槽位，取值字面量 'stdio'（stream-json 控制通道）或某个 MCP 工具名，二者互斥
  // （CLI/SDK 同时配置直接报错；官方 SDK 的 canUseTool 正是用 stdio 实现的）。这里取
  // 进程内的控制通道，MCP 桥方案暂缓（见 plan Task 11 决策记录）。
  if (streamInput) args.push('--input-format', 'stream-json', '--permission-prompt-tool', 'stdio');
  return args;
}

// 权限转发：对每个 control_request(can_use_tool) 独立询问审批闸并回写 control_response。
// 刻意不阻塞 stdout 读取循环——等用户点卡期间 CLI 可能继续产出行，串行 await 会造成
// 队头阻塞（事件流冻结）。审批闸缺失（绕过 server 直调 run()）→ fail-closed 拒绝，
// 与 pi 写/执行工具的缺省拒绝同一约定（Task 10）。
function answerPermissionRequest(stdin, ev, ask) {
  const finish = (allow, message) => {
    const line = JSON.stringify(
      buildControlResponse(ev.requestId, { allow, input: ev.input, message, toolUseId: ev.toolUseId }),
    ) + '\n';
    // stdin 已关（CLI 已退出）时写入会 EPIPE：由全局的 stdin 'error' 吞掉，此处再兜一层。
    try { stdin.write(line); } catch { /* 进程已退出，无需应答 */ }
  };
  if (typeof ask !== 'function') {
    finish(false, 'approval gate unavailable');
    return;
  }
  Promise.resolve()
    .then(() => ask(ev.toolName, summarizeToolInput(ev.toolName, ev.input)))
    .then((allow) => finish(Boolean(allow)))
    // 审批闸自身抛错同样按拒绝收敛，绝不让未处理的 rejection 冒泡杀掉宿主进程。
    .catch(() => finish(false, 'approval gate errored'));
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
// config dir 不在这里删：归会话所有的必须跨重启存活（见 configDirFor 的注释），
// 只有无主目录（keep=false 已在 finally 里删过）才可能残留，而无主目录不进这个表。
function sweepSync(sig) {
  for (const c of liveChildren) killTree(c, sig);
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

export function createCcAdapter({ cliPath = 'claude', env = {}, transcripts = null } = {}) {
  return {
    id: 'cc',
    async available() {
      if (cliPath.includes('/')) return existsSync(cliPath);
      const paths = (process.env.PATH ?? '').split(':');
      return paths.some((p) => p && existsSync(join(p, cliPath)));
    },
    async *run({ messages, model, apiKey, baseUrl, anthropicApi, cwd, allowedTools = [], resumeSessionId, signal, toolTier, requestApproval, sessionId }) {
      // full 级别 = 双向 stream-json：回合提示经 stdin 的 user 消息驱动，权限提示经
      // 控制通道往返（--permission-prompt-tool stdio）。其余级别与旧行为完全一致。
      const interactive = toolTier === 'full';
      // 目录归会话所有：同一 sessionId 的后续 turn 复用同一目录，--resume 才找得到
      // transcript（见上面 configDirFor 的说明）。只有无主目录才在 turn 结束时删。
      const { dir: configDir, keep } = configDirFor(transcripts, sessionId);
      let child;
      try {
        child = spawn(cliPath, buildArgs({ allowedTools, resumeSessionId, streamInput: interactive }), {
          cwd: cwd || process.cwd(),
          env: {
            ...sanitizeChildEnv(process.env),
            ...env,
            CLAUDE_CONFIG_DIR: configDir,
            // Anthropic 兼容端点优先（openrouter 在 /api 而非 OpenAI 风格的 /api/v1）
            ANTHROPIC_BASE_URL: anthropicApi || baseUrl,
            ANTHROPIC_AUTH_TOKEN: apiKey ?? '',
            ANTHROPIC_API_KEY: '',
            ANTHROPIC_MODEL: model,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true, // 自成进程组，供 killTree(-pid) 整组清理（stdout/stderr 仍是管道）
        });
      } catch (err) {
        // 同步 spawn 失败（参数非法等）：无主目录必须回收，否则泄漏。
        // 会话目录留给 disposeSession / TTL——此刻删掉会让后续 turn 的 resume
        // 失去目标（正是本修复要消灭的失败模式）。
        if (!keep) dropOwnedDir(configDir);
        yield { type: 'error', message: `failed to spawn claude: ${err.message}` };
        return;
      }

      liveChildren.add(child);
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
      // 可能的凭证回显进入上层日志。ATBX_VERBOSE=1 时逐行转发到本地终端排障。
      if (VERBOSE) {
        createInterface({ input: child.stderr }).on('line', (l) => logErr('cc:stderr', l.slice(0, 200)));
      } else {
        child.stderr.resume();
      }
      // 子进程可能在消费 stdin 之前就退出（例如未读取 stdin 的 CLI / 启动即失败），
      // 此时管道已关闭，写入会抛 EPIPE。这是「prompt 送不到」而非适配器故障，
      // 真正的结论由 stdout 上的终结事件或退出码给出，因此这里显式吞掉写入错误——
      // 否则 unhandled 'error' 会直接炸掉测试进程。
      child.stdin.on('error', () => {});
      // stdin.end 幂等（end 后再 end 是无害 no-op）：result 行处提前关 + finally 兜底共用。
      const endStdin = () => { try { child.stdin.end(); } catch { /* 流已销毁，忽略 */ } };
      try {
        if (interactive) {
          // stream-json 输入：回合提示是 stdin 上的一行 user 消息（形状对齐官方 SDK）。
          // stdin 刻意不 end()——控制通道的 control_response 要在同一管道上回写。
          child.stdin.write(JSON.stringify({
            type: 'user',
            session_id: '',
            message: { role: 'user', content: [{ type: 'text', text: lastUserText(messages) }] },
            parent_tool_use_id: null,
          }) + '\n');
        } else {
          child.stdin.write(lastUserText(messages));
          child.stdin.end();
        }
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
            // 权限帧在本适配器内部闭环（询问抽屉 → 回写控制通道），不进事件流——
            // 前端看到的将是网关的 permission_request SSE 帧（Task 9 契约）。
            if (ev.type === 'control_request') {
              answerPermissionRequest(child.stdin, ev, requestApproval);
              continue;
            }
            if (ev.type === 'error' && isGateError(ev.message)) ev.gate = true;
            if (ev.type === 'turn_end' || ev.type === 'error') {
              sawTerminal = true;
              // 回合终结：把 cc 的 session id 和 config dir 记进 transcript 记录，
              // 重启/LRU 逐出后 restore() 与下一轮 --resume 才有据可依。
              // 刻意只写这三个字段（cwd 等别的归 server 管，逐字段合并不会互踩）。
              if (transcripts && sessionId && ev.sessionId) {
                transcripts.save({
                  id: sessionId, adapter: 'cc', agent: 'cc',
                  configDir, ccSessionId: ev.sessionId,
                });
              }
              // 回合的 result 行已到（成功 → turn_end；is_error → error）：交互模式在此
              // 立即 end stdin。真实 CLI（2.1.302 实测）发完 result 后握着 stdin 不退，
              // 等控制通道的下一回合——拖到 finally 才 end 的话，stdout 的 for-await
              // 永不结束 → run() 挂死 → SSE 没有 done 帧 → 会话永久 streaming，后续
              // /messages 全部 409。官方 SDK 同款（收到首个 result 即 closing stdin）。
              // 迟到才结算的审批回写会 EPIPE：由上面的 stdin 'error' 监听 + try/catch 吞掉。
              if (interactive) endStdin();
            }
            yield ev;
          }
        }
        const tail = parseCcLine(buffer.trim());
        if (tail) {
          if (tail.type === 'error' && isGateError(tail.message)) tail.gate = true;
          if (tail.type === 'turn_end' || tail.type === 'error') {
            sawTerminal = true;
            if (interactive) endStdin(); // 与循环内同款：result 行已到即关 stdin（幂等）
            if (transcripts && sessionId && tail.sessionId) {
              transcripts.save({
                id: sessionId, adapter: 'cc', agent: 'cc',
                configDir, ccSessionId: tail.sessionId,
              });
            }
          }
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
        // interactive 模式 stdin 一直开着（控制通道）：收尾时补一个 EOF（幂等——
        // 正常路径已在 result 行处 end 过），让还活着的 CLI 的 stdin 读取端自然
        // 结束，而不是干等到被 SIGTERM。
        if (interactive) endStdin();
        // 不在这里 delete(liveChildren)：交给 'close' 回调，避免「已发信号但未死透」
        // 期间从进程退出兜底钩子的视野里消失（见上面 close 监听）。
        terminate(child); // SIGTERM + 宽限后 SIGKILL，保证最终一定死
        // 只删「无主」目录：归会话所有的已记进 transcript 记录，要跨重启存活。
        if (!keep) dropOwnedDir(configDir);
      }
    },
    // 会话终结（TTL/容量逐出、客户端关抽屉）时由 server 调用。这里的 dispose
    // 只释放内存簿记（旧版 Map 缓存已删，如今没有内存态可释放，no-op）——
    // **不删** transcript 记录或 config dir：被逐出的会话历史正是「重启后
    // 还能恢复」的那份，删了恢复就成了空话。磁盘回收只经由 transcript 的
    // remove()/sweep()（用户删除 / TTL 到期）。
    disposeSession() {},
    // 测试钩子：revive（新建空目录并清掉旧 ccSessionId）不经 spawn，无法从
    // 外部触发——暴露 configDirFor 本体供测试直接驱动。
    __configDirFor(sessionId) { return configDirFor(transcripts, sessionId); },
    // 恢复材料：重启 / 内存逐出后由 server 调用，拿到 config dir 和上次的
    // cc session id，下一轮 turn 才能带 --resume。强校验：configDir 与
    // ccSessionId 都在、目录存在、且 projects/ 下真有 <ccSessionId>.jsonl——
    // 缺 transcript 文件时 --resume 必然失败（"No conversation found"），
    // 一个「看似可恢复」的假阳性会让用户看到一条注定失败的回合。
    restore(sessionId) {
      const rec = transcripts?.get(sessionId);
      if (!rec?.configDir || !rec.ccSessionId) return null;
      if (!existsSync(rec.configDir)) return null;
      return findCcTranscript(rec.configDir, rec.ccSessionId)
        ? { configDir: rec.configDir, ccSessionId: rec.ccSessionId }
        : null;
    },
  };
}

// configDir 下有没有 <sessionId>.jsonl：claude 按 projects/<cwd-slug>/<id>.jsonl
// 存 transcript，slug 取决于当时的 cwd，不猜——直接扫两层目录找文件名。
function findCcTranscript(configDir, ccSessionId) {
  const projects = join(configDir, 'projects');
  let slugs;
  try { slugs = readdirSync(projects, { withFileTypes: true }); } catch { return false; }
  const target = `${ccSessionId}.jsonl`;
  for (const d of slugs) {
    if (!d.isDirectory()) continue;
    try {
      if (readdirSync(join(projects, d.name)).includes(target)) return true;
    } catch { /* 目录刚好被删：继续找别的 slug */ }
  }
  return false;
}

// 回收一个「无主」（未绑定 sessionId）的隔离目录。有主的走 transcript 的
// remove()/sweep()，不能在单个 turn 结束时删。
function dropOwnedDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
}
