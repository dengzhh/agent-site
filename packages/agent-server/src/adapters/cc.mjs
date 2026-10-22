// Claude Code 适配器：把 claude CLI 的 headless stream-json 转成统一事件流。
// 关键安全点：CLAUDE_CONFIG_DIR 指向临时空目录，阻止 CLI 加载用户的
// ~/.claude/settings.json（否则会用用户默认模型并执行其 hooks——已实测）。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, existsSync, rmSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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
// 记录**（configDir 字段）。磁盘记录让目录跨进程存活（网关重启 / LRU 逐出后
// 仍可 resume），与历史本身同生共死（remove()/sweep() 删记录时一并回收目录）。
// 没传 transcripts 的调用方退回内存 Map（0.5.2 的行为）：同一进程内同
// sessionId 复用目录，进程退出兜底统一回收——server.mjs 目前正是这条路
// （还没把 store 接进来），删了它线上立刻回到「第 2 条消息报错」。

// 无 store 时的后备缓存：sessionId → { dir, lastUsed }。仅进程内有效；
// 谁来删见 configDirFor 的注释与 sweepSync。
const fallbackDirs = new Map();

// 取本会话的隔离目录。返回 { dir, keep }：
//   keep = true  → 目录归会话所有（已记入 transcript 记录或挂在后备缓存里）。
//                  调用方**不得**在单个 turn 结束时删它（下一轮 --resume 还要
//                  靠它）；回收只经由 transcript.remove()/sweep()/disposeSession/
//                  进程退出兜底。
//   keep = false → 调用方没给 sessionId，没有归属，turn 结束就删（一次性调用）。
function configDirFor(transcripts, sessionId) {
  if (!sessionId) return { dir: mkdtempSync(join(tmpdir(), 'atbx-cc-')), keep: false };
  if (transcripts) {
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
      // 刻意不在 turn 开始前写别的字段：回合失败时记录里会留一条只有
      // configDir 的桩记录，这是接受的——它无害（restore() 返回 null），
      // 且让 remove() 能收回这个已存在的目录。
      transcripts.save({ id: sessionId, configDir: dir, ccSessionId: null });
      return { dir, keep: true };
    }
    // id 不安全（不该发生：server 早已验过形状）——落到底下的后备分支。
  }
  // 无 store：同 sessionId 复用一个进程内目录（0.5.2 行为），跨 turn 保
  // --resume 能找到 transcript；但不能跨进程，重启后历史丢了，目录可重建。
  const hit = fallbackDirs.get(sessionId);
  if (hit) {
    fallbackDirs.delete(sessionId); // 重新插入 → 刷新 LRU 序
    hit.lastUsed = Date.now();
    fallbackDirs.set(sessionId, hit);
    return { dir: hit.dir, keep: true };
  }
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-'));
  fallbackDirs.set(sessionId, { dir, lastUsed: Date.now() });
  return { dir, keep: true };
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
// 归 store 所有的 config dir 不在这里删——它必须跨重启存活，磁盘回收是
// transcript.remove()/sweep() 的事。无 store 的后备目录则相反：进程一死就没
// 有任何记录能找回它，留着只会堆积，退出时统一扫掉（实时逐条删不划算，
// 'exit' 阶段一次性 rm 更简单也更完备）。
function sweepSync(sig) {
  for (const c of liveChildren) killTree(c, sig);
  for (const { dir } of fallbackDirs.values()) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
  fallbackDirs.clear();
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
        // 会话目录归 fallbackDirs / transcript 记录所有——此刻删掉会让后续
        // turn 的 resume 失去目标（正是本修复要消灭的失败模式）。
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
              // 回合成功终结：把 cc 的 session id 和 config dir 记进 transcript
              // 记录，重启/LRU 逐出后 restore() 与下一轮 --resume 才有据可依。
              // 刻意只写这三个字段（cwd 等别的归 server 管，逐字段合并不会互踩）。
              // 刻意只在 turn_end 写：失败回合的 id 不可信（CLI 常在吐 result 前
              // 就换 id），盖掉上一个好 id 等于把能 resume 的会话废掉。
              if (ev.type === 'turn_end' && transcripts && sessionId && ev.sessionId) {
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
            if (tail.type === 'turn_end' && transcripts && sessionId && tail.sessionId) {
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
        // 只删「无主」目录（没给 sessionId 的一次性调用）：归会话所有的要么
        // 已记进 transcript 记录，要么挂在 fallbackDirs 里留给后续 turn。
        if (!keep) dropOwnedDir(configDir);
      }
    },
    // 会话终结（TTL/容量逐出、客户端关抽屉）时由 server 调用。
    // store 有记录的会话：**不删**记录或 config dir——被逐出的会话历史正是
    // 「重启后还能恢复」的那份，删了恢复就成了空话；磁盘回收只经由
    // transcript 的 remove()/sweep()（用户删除 / TTL 到期）。
    // 无 store 的会话：目录只挂在内存缓存里，会话一终结它就成了没人再引用
    // 的孤儿（缓存键是 sessionId，逐出后不会再命中），留到进程退出才扫只会
    // 堆积——此刻删，与 0.5.2 的 dropConfigDir 同一职责。
    disposeSession(id) {
      if (!id || transcripts) return;
      const hit = fallbackDirs.get(id);
      if (!hit) return;
      fallbackDirs.delete(id);
      try { rmSync(hit.dir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    },
    // 恢复材料：重启 / 内存逐出后由 server 调用，拿到 config dir 和上次的
    // cc session id，下一轮 turn 才能带 --resume。强校验：configDir 与
    // ccSessionId 都在、目录存在、且 projects/ 下真有 <ccSessionId>.jsonl——
    // 缺 transcript 文件时 --resume 必然失败（"No conversation found"），
    // 一个「看似可恢复」的假阳性会让用户看到一条注定失败的回合。
    restore(sessionId) {
      const rec = transcripts?.get(sessionId);
      if (!rec?.configDir || !rec.ccSessionId) return null;
      if (!existsSync(rec.configDir)) return null;
      if (!findCcTranscript(rec.configDir, rec.ccSessionId)) return null;
      // 读得到对话就一并带上：网页于是能显示思维链 + 正文，与 pi 一致。
      // 读不到（jsonl 没了 / 一行对话都没有）就只回指针——--resume 照常续
      // 上下文，前端照「已接上本机的 Claude Code 会话」提示走。
      // **绝不回空数组**：那会画出「已恢复历史对话，0 条消息」的假横幅，
      // 比不显示更糟。
      const dialogue = readCcDialogue(rec.configDir, rec.ccSessionId);
      return {
        configDir: rec.configDir, ccSessionId: rec.ccSessionId,
        ...(dialogue ? { messages: dialogue } : {}),
      };
    },
  };
}

// 从 CLI 的 jsonl 里把对话读出来。返回 [{role, content}]（与 pi 存进
// rec.messages 的形状逐字段一致，前端同一条渲染路径），或 null（读不到 /
// 一行对话都没有）。
//
// 判据是**行首的 type 字段**，不是 message.role：实测噪声行也带 role——
// api-request-blob 的 message.role 就是 'user'，按 role 筛会把 8474 字符的
// system prompt 当用户消息渲染出来（2026-10-23 实测一份真实 transcript）。
// type ∈ {user, assistant} 才是 CLI 写下的对话。
//
// 不按 isMeta 过滤：真实 transcript 可能带 isMeta 元信息行（slash 命令输出
// 之类），但该字段未经本仓库任何代码/测试验证（读真实 transcript 有 PII
// 边界约束，无法核对）。风险不对称——不过滤最多多显示一行外观噪音，过滤
// 错了会静默吞掉真对话。要加这条过滤，先用真实 transcript 核对再动。
//
// 只在 restore() 里调一次（POST /sessions 时），绝不每轮读、也绝不把内容
// 搬进我们的记录：权威副本只有 CLI 那一份，存第二份就有了两个可能不一致
// 的真源。记录继续只留 configDir + ccSessionId 两个指针。
function readCcDialogue(configDir, ccSessionId) {
  if (!configDir || !ccSessionId) return null;
  const projects = join(configDir, 'projects');
  let slugs;
  try { slugs = readdirSync(projects, { withFileTypes: true }); } catch { return null; }
  const target = `${ccSessionId}.jsonl`;
  for (const d of slugs) {
    if (!d.isDirectory()) continue;
    const file = join(projects, d.name, target);
    let raw;
    try { raw = readFileSync(file, 'utf8'); } catch (err) {
      // findCcTranscript 刚确认文件存在、这里却读失败（权限 / 竞态删除）：
      // 用户会看到「历史没了」而毫无线索，VERBOSE 下给一条诊断。别的 slug
      // 没命中也会走到这里，但那种沉默是 fallback 设计如此——只有 errno
      // 不是「文件本来就没有」（ENOENT 之外的错）才值得出声。
      if (err?.code !== 'ENOENT' && VERBOSE) {
        logErr('cc:restore', `transcript read failed: sessionId=${ccSessionId} file=${file} ${err?.code || err?.message}`);
      }
      continue; // 别的 slug：继续找
    }
    const out = [];
    // 逐行 parse，单行坏了只丢那一行——一份 213 KB 的文件不该因为末尾半行
    // 而整个读不出来。
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj?.type !== 'user' && obj?.type !== 'assistant') continue;
      const msg = obj.message;
      if (!msg || typeof msg !== 'object') continue;
      // content 必须是块数组（Anthropic 标准形状）；字符串 content 也见得过，
      // 原样留着让前端按字符串路径渲染。
      const content = msg.content;
      if (!Array.isArray(content) && typeof content !== 'string') continue;
      out.push({ role: obj.type, content });
    }
    // 一行对话都没有 → 当没读到（调用方据此只回指针，不返回空数组）。
    // 文件确实读到了却零对话，多半不是用户预期——VERBOSE 下给条线索。
    if (!out.length && VERBOSE) {
      logErr('cc:restore', `transcript had no dialogue lines: sessionId=${ccSessionId} file=${file}`);
    }
    return out.length ? out : null;
  }
  return null;
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

// 回收一个「无主」（未绑定 sessionId）的隔离目录。有主的归 transcript 的
// remove()/sweep() 或 fallbackDirs 的 disposeSession/进程退出兜底，不能在
// 单个 turn 结束时删。
function dropOwnedDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
}
