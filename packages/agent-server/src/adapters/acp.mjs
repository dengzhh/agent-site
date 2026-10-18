// ACP 适配器：用官方 SDK 通过 stdio JSON-RPC 驱动任意 ACP agent
// （hermes / openclaw / opencode / codex / dsh）。事件映射到统一契约，
// 与 pi / cc 适配器对等。
//
// 已实测要点（踩坑，勿改）：
//  - ndJsonStream(output, input)：output=我们写→agent 读；input=agent 写→我们读。
//    参数写反会抛 "input.getReader is not a function"。
//  - 需要 Web Streams，用 toWeb 转换 Node 流。
//  - agent 的 stderr 噪声极大（hermes 会打插件注册日志），必须持续排空：
//    不读会填满管道缓冲导致子进程阻塞；但内容绝不进事件流（可能回显凭证）。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { mapSessionUpdate, describePermission, resolveOutcomeOptionIds } from './acp-stream.mjs';
import { ACP_AGENTS } from './acp-agents.mjs';
import { VERBOSE, logErr } from '../log.mjs';

// 取最后一条 user 消息的文本作为本轮 prompt，与 pi/cc 适配器语义一致。
function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i].content ?? '');
  }
  return '';
}

// PATH 查找（含可执行位检查，避免命中同名目录或不可执行文件）。
async function commandExists(cmd) {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolve) => {
    execFile('which', [cmd], (err) => resolve(!err));
  });
}

export function createAcpAdapter({ agents = ACP_AGENTS, probe } = {}) {
  return {
    id: 'acp',

    // 适配器本身恒可用；「某个 agent 是否可用」由 availableFor 回答。
    async available() { return true; },

    async availableFor(agentId) {
      if (probe) return await probe(agentId);
      // hasOwn 而非 `agents[id]`：后者会对 'constructor'/'toString' 等原型键返回真值。
      if (!Object.hasOwn(agents, agentId)) return false;
      return await commandExists(agents[agentId].cmd);
    },

    async *run({ agentId, messages, cwd = process.cwd(), toolTier, signal, requestApproval } = {}) {
      if (!Object.hasOwn(agents, agentId)) {
        yield { type: 'error', message: `unknown acp agent: ${agentId}` };
        return;
      }
      const def = agents[agentId];

      // 隔离目录：agent 的配置/会话状态写进一次性目录，绝不碰用户真实配置。
      // 建好后必须由 finally 回收（生成器被提前 return 时同样要清）。
      const home = mkdtempSync(join(tmpdir(), 'atbx-acp-'));
      let child;
      try {
        child = spawn(def.cmd, def.args, {
          cwd,
          env: { ...process.env, ...def.isolateEnv(home) },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        // 同步 spawn 失败（参数非法等）：目录已建好，必须回收。
        rmSync(home, { recursive: true, force: true });
        yield { type: 'error', message: `failed to spawn ${def.cmd}: ${err.message}` };
        return;
      }

      // spawn 失败多为异步上报（ENOENT：二进制不存在 / 路径错）。不监听会被
      // Node 当作 unhandled 'error' 直接杀掉宿主进程——转成正常 error 事件。
      let spawnError = null;
      child.on('error', (err) => { spawnError = err; });
      // stderr 同样必须排空（见 cc.mjs 注释）。VERBOSE 时逐行带 agent 名转发。
      if (VERBOSE) {
        createInterface({ input: child.stderr }).on('line', (l) => logErr(`acp:${agentId}`, l.slice(0, 200)));
      } else {
        child.stderr.resume();
      }

      // abort → 立即杀子进程。监听器挂在 signal 上而非只靠 finally：生成器可能
      // 正挂在 yield 上等消费者取事件，此时 finally 不会执行，但 abort 必须生效。
      let aborted = false;
      const onAbort = () => { aborted = true; try { child.kill('SIGKILL'); } catch { /* 已退出 */ } };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin),   // output：我们写 → agent 读
        Readable.toWeb(child.stdout),  // input：agent 写 → 我们读
      );

      // 通知回调 → 异步生成器：队列 + 单次唤醒桥接（同 pi.mjs 的 settle-flag 模式）。
      // 正确性要点：settled 由驱动 Promise 的 finally 置位并唤醒，因此错误路径
      // 也会退出（不悬挂）；退出条件为「队列非空 或 未 settle」，保证 settle 与
      // 最后一次 yield 之间积压的事件仍被排空（不丢失）。
      const queue = [];
      let settled = false;
      let wake = null;
      const notify = () => { const w = wake; wake = null; w?.(); };
      const push = (ev) => { queue.push(ev); notify(); };

      const client = {
        async sessionUpdate(params) {
          for (const ev of mapSessionUpdate(params)) push(ev);
        },
        // 权限应答（期 1 Task 5 启发式 + 期 2 Task 12 抽屉转发）：
        //  - read 级别：维持期 1 启发式——title/kind 命中只读词表放行，其余拒绝，
        //    不经抽屉；none 级别 acp 本不该跑工具，同样恒拒绝。
        //  - full 级别：转发抽屉 ctx.requestApproval(action, summary)（Task 9 注入）。
        // 这里直接闭包捕获 requestApproval 即可，无需 pi 那套可变引用（pi 跨轮缓存
        // Agent 才需要 approvals.current）；acp 每次 run 现场拉起子进程、现场构造
        // client 对象，闭包绑定的就是当轮注入的闸，不存在跨轮引用过期问题。
        // 闸缺失（绕过 server 直调适配器）或自身抛错 → fail-closed 拒绝（与 Task
        // 10/11 同一约定），绝不 throw——rejection 会让 SDK 的 RPC 层视为应答失败，
        // agent 侧回合悬死。
        // outcome 的 optionId 按请求自带 options 解析（各 agent 命名不一致，见
        // resolveOutcomeOptionIds），不硬编码。
        async requestPermission(req) {
          const { allowId, rejectId } = resolveOutcomeOptionIds(req?.options);
          const answer = (allow) => ({ outcome: { outcome: 'selected', optionId: allow ? allowId : rejectId } });
          if (toolTier !== 'full') {
            const call = req?.toolCall ?? {};
            const title = String(call.title ?? call.name ?? '');
            const kind = String(call.kind ?? '');
            const readonly = /read|view|grep|glob|search|list|find|inspect|ls/i.test(`${title} ${kind}`);
            return answer(toolTier === 'read' && readonly);
          }
          if (typeof requestApproval !== 'function') return answer(false);
          try {
            const { action, summary } = describePermission(req?.toolCall);
            return answer(Boolean(await requestApproval(action, summary)));
          } catch {
            return answer(false);
          }
        },
        async readTextFile() { throw new Error('fs not supported'); },
        async writeTextFile() { throw new Error('fs not supported'); },
      };

      Promise.resolve()
        .then(async () => {
          const conn = new acp.ClientSideConnection((_agent) => client, stream);
          await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
          const s = await conn.newSession({ cwd, mcpServers: [] });
          const r = await conn.prompt({
            sessionId: s.sessionId,
            prompt: [{ type: 'text', text: lastUserText(messages) }],
          });
          push({ type: 'turn_end', stopReason: r?.stopReason ?? null });
        })
        .catch((err) => push({ type: 'error', message: String(err?.message ?? err) }))
        .finally(() => { settled = true; notify(); });

      try {
        while (queue.length > 0 || !settled) {
          if (queue.length > 0) { yield queue.shift(); continue; }
          await new Promise((r) => { wake = r; });
        }
        // 若 spawn 从未成功（无事件流），把 spawnError 作为结论透出。
        if (spawnError) yield { type: 'error', message: `failed to spawn ${def.cmd}: ${spawnError.message}` };
        else if (aborted) yield { type: 'error', message: 'acp agent aborted', aborted: true };
      } finally {
        // 生成器被提前 return()（调用方 break / 客户端断开）时子进程可能仍活着：
        // 一个 ACP turn 可能跑很久，不清理就是孤儿进程。正常结束时 kill 幂等无害。
        if (signal) signal.removeEventListener('abort', onAbort);
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}
