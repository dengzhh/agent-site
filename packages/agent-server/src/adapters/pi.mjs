// pi 适配器：进程内 pi-agent-core 运行时的封装，事件转成统一契约
// （delta / turn_end / error），与 cc 适配器成为对等实现。
//
// Agent 按 sessionId 跨轮缓存——这是多轮上下文的承载处之一：前端每轮只发
// `{ text }`，历史只能由服务端持有。Agent 的 transcript 是可变状态，每轮新建
// 一个 Agent 会让模型在第 2 轮只看到本轮那一句（回归已实测：见
// test/server.test.mjs 的 multi-turn 用例）。缓存没了（重启 / LRU 逐出）也不要紧：
// 成功的回合已落盘到 TranscriptStore，冷启动会把记录重新播种给新 Agent。
import { Agent } from '@earendil-works/pi-agent-core';
import { readOnlyTools, fullTools } from './pi-tools.mjs';
import { withUsage, buildPiSessionLines, renderPiSession } from '../pi-session-writer.mjs';
import { logErr } from '../log.mjs';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
// 免费模型推理排队慢（OpenRouter 免费档高峰可等数分钟），OpenAI SDK 默认 10 分钟超时
// 会被 undici 的 300s headersTimeout 先打断（"Request timed out"）。修法两层：
// ① streamSimple 传大 timeoutMs（SDK 侧）；② 传 undici 包的 fetch + 长超时 dispatcher
// （传输层——SDK 用全局 fetch 时其内置 undici 的 300s headersTimeout 无法配置）。
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';

const SYSTEM_PROMPT = 'You are a helpful assistant chatting in the AgentToolbox web app. Be concise and useful.';
// 这些终结原因留下的 assistant 消息是占位（空文本 / abort / 错误），喂回模型
// 就是脏上下文——绝不落盘。'error' 与 'aborted' 库都会发 turn_end
// （agent.js 的 stopReason: aborted ? 'aborted' : 'error'），缺一个都会把
// 坏轮写进历史；用集合而不是字符串比较，新出现的脏原因一眼可见。
const DIRTY_STOP_REASONS = new Set(['error', 'aborted']);
const STREAM_TIMEOUT_MS = 15 * 60_000;

const streamDispatcher = new UndiciAgent({
  headersTimeout: STREAM_TIMEOUT_MS,
  bodyTimeout: STREAM_TIMEOUT_MS,
});
const longTimeoutFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: streamDispatcher });

// pi CLI 原生格式要求每条消息的 content 是**数组**（[{type:'text',text:…}]），
// 而 Agent 状态的 user 消息 content 是纯字符串。CLI 读的是数组形状，
// 直接喂字符串会解析不出内容（实测 CLI 能读但内容为空/报错）——统一转成数组。
// system 消息（Agent 的 systemPrompt）不参与对话，CLI 会自己带 system 行。
function conversationMessages(messages = []) {
  return messages
    .filter((m) => m && typeof m === 'object' && m.role !== 'system')
    .map((m) => (Array.isArray(m.content)
      ? m
      : { ...m, content: [{ type: 'text', text: String(m.content ?? '') }] }));
}

// 取最后一条 user 消息的文本作为本轮 prompt，与 server.mjs 的
// `body.text` / cc 适配器的 lastUserText 语义一致。
function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return String(messages[i].content ?? '');
  }
  return '';
}

// 会话标题：首条 user 消息的前 40 字。content 可能是字符串，也可能是
// pi 形状的 [{type:'text',text}] 数组——两种都取文本。
function deriveTitle(messages = []) {
  const firstUser = (messages ?? []).find((m) => m && m.role === 'user');
  if (!firstUser) return null;
  const raw = Array.isArray(firstUser.content)
    ? firstUser.content.map((b) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('')
    : String(firstUser.content ?? '');
  return raw.trim().slice(0, 40) || null;
}

function defaultMakeAgent(models, model, sessionId, apiKey, tools, restoredMessages) {
  return new Agent({
    // tools（tier=read 时的只读三件套）会成为 Agent 的 leading system message，
    // 属于 Agent 身份的一部分：tier/cwd 变更必须重建 Agent（见 cacheKey）。
    // restoredMessages 存在时作为初始 transcript：这是 pi-agent-core 唯一的
    // 恢复入口——库本身不落盘，跨进程续命只能靠把历史喂回 initialState.messages。
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      ...(tools ? { tools } : {}),
      ...(restoredMessages?.length ? { messages: restoredMessages } : {}),
    },
    streamFn: (m, context, options) => models.streamSimple(m, context, {
      ...options,
      timeoutMs: STREAM_TIMEOUT_MS,
      fetch: longTimeoutFetch,
    }),
    sessionId,
    getApiKey: () => apiKey,
  });
}

export function createPiAdapter({ models, resolve, makeAgent = defaultMakeAgent, capacity = 16, transcripts = null, piSessionDir = null } = {}) {
  // sessionId → { agent, cacheKey }。LRU 容量与 server 的 SessionStore 对齐（16）；
  // 被淘汰的会话下一次发言时从 transcripts 里的持久记录重新播种（缓存未命中
  // 且 store 有该会话的历史），而不是从空白对话开始。
  const agents = new Map();
  // 缓存键必须覆盖 agent 身份的全部维度：换模型换 key 都得换 Agent（否则会把
  // 上一模型的上下文与凭据带过去）；cwd/toolTier 变更意味着换工具集（工具闭包
  // 绑定 cwd，tier 决定工具在不在），旧 Agent 的工具集已定型，必须重建。只比较
  // 引用，不存 key 明文。
  const cacheKey = (model, apiKey, cwd, toolTier) =>
    `${model.provider}/${model.id}\u0000${apiKey ?? ''}\u0000${cwd ?? ''}\u0000${toolTier ?? ''}`;

  // 缓存条目：{ agent, cacheKey, approvals }。approvals 是可变审批引用（见 run 内
  // 注释）：full 级别的工具闭包经它间接调用「当轮」的审批函数，Agent 跨轮缓存时
  // 每轮只换 current，工具数组本身不重建。
  function agentFor(model, sessionId, apiKey, cwd, toolTier, tools, approvals, restored) {
    const key = cacheKey(model, apiKey, cwd, toolTier);
    const hit = agents.get(sessionId);
    if (hit && hit.cacheKey === key) {
      agents.delete(sessionId);      // 重新插入 → 刷新 LRU 序
      agents.set(sessionId, hit);
      return hit.agent;
    }
    const agent = makeAgent(models, model, sessionId, apiKey, tools, restored);
    agents.delete(sessionId);
    agents.set(sessionId, { agent, cacheKey: key, approvals });
    while (agents.size > capacity) agents.delete(agents.keys().next().value);
    return agent;
  }

  // 从 store 取恢复材料。只有 adapter 字段也对得上才认：pi 拿 cc 的历史去
  // 播种，模型看到的会是一份自己没说过的「回复」，比丢历史更糟。
  // （命名上刻意与对外的 restore() 区分：这是内部的播种取材，不是公开契约。）
  function loadPersistedMessages(sessionId) {
    if (!transcripts || !sessionId) return null;
    const rec = transcripts.get(sessionId);
    if (rec?.adapter !== 'pi' || !Array.isArray(rec.messages) || rec.messages.length === 0) return null;
    return rec.messages;
  }

  return {
    id: 'pi',
    async available() { return true; },
    // cache=false → 本轮走一次性 Agent（不读也不写缓存）。目前没有调用方传它
    // （registry 不做 failover）；保留是因为它定义了「不碰共享状态的一趟运行」
    // 的语义，下面播种/落盘的分支必须与它对称。
    async *run({ messages, request, apiKey = null, sessionId, signal, cache = true, toolTier, cwd, requestApproval } = {}) {
      const { model } = resolve(models, request);
      // 工具按本轮 cwd/tier 现场解析（闭包绑定 cwd）；cwd/tier 任一变更都体现在
      // 缓存键里 → 缓存未命中 → Agent 带新工具集重建。tier 给了但没有 cwd 时不给
      // 工具：没有硬边界就不启用。
      // full 级别的审批闸经可变引用间接调用：server 注入的 requestApproval 闭包
      // 绑定「当轮」的 SSE 响应，而 Agent（连同其工具）跨轮缓存——直接烘焙进工具
      // 闭包会让第 2 轮的权限帧写进第 1 轮已结束的响应，审批永远无人应答。缓存
      // 命中时复用旧引用（工具闭包持的就是它），每轮开始只刷新 current。两个会话
      // 并发时各有自己的缓存条目与引用，互不串扰。无注入 → 恒拒绝（fail closed）。
      const key = cacheKey(model, apiKey, cwd, toolTier);
      const hit = cache && sessionId ? agents.get(sessionId) : null;
      const cached = hit && hit.cacheKey === key ? hit : null;
      const approvals = cached?.approvals ?? { current: null };
      const ask = (action, summary) => {
        const fn = approvals.current;
        return fn ? fn(action, summary) : Promise.resolve(false);
      };
      const tools =
        toolTier === 'full' && cwd ? fullTools(cwd, ask)
        : toolTier === 'read' && cwd ? readOnlyTools(cwd)
        : undefined;
      // 冷启动播种：缓存未命中（网关重启 / LRU 逐出 / 新进程）且 store 里有这个
      // 会话的历史时，经 makeAgent 的第 6 参把消息喂进 initialState.messages
      // （pi-agent-core 唯一的恢复入口）。去重判据是缓存命中本身——命中说明
      // 内存里的 Agent 就是这些历史的持有者，再喂一遍历史就会翻倍，故只在
      // cached === null（真的新建 Agent）才取历史；cache=false 的一次性 Agent
      // 刻意不播种：那趟运行不写缓存也不该读共享历史。
      const restored = !cached && cache && sessionId ? loadPersistedMessages(sessionId) : null;
      const agent = cache && sessionId
        ? agentFor(model, sessionId, apiKey, cwd, toolTier, tools, approvals, restored)
        : makeAgent(models, model, sessionId, apiKey, tools);
      approvals.current = typeof requestApproval === 'function' ? requestApproval : null;

      // subscribe 回调 → 异步生成器：用队列 + 单次唤醒桥接。
      // 正确性要点（否则会挂起或丢事件）：
      //  - `settled` 由 prompt 的 finally 置位并唤醒等待者，保证队列空且 prompt
      //    结束后循环必然退出（错误路径同样走 finally，不会悬挂）；
      //  - 退出条件写成「队列非空 或 未 settle」，因此 settle 与最后一个 yield
      //    之间积压的事件仍会在退出前被排空，不会丢失；
      //  - wake 在 await 前同步赋值，push/settle 只调用一次即清空，无丢唤醒竞态。
      const queue = [];
      let settled = false;
      let wake = null;
      const notify = () => { const w = wake; wake = null; w?.(); };
      const push = (ev) => { queue.push(ev); notify(); };

      const unsub = agent.subscribe((ev) => {
        if (ev.type === 'message_update' && ev.assistantMessageEvent.type === 'text_delta') {
          push({ type: 'delta', text: ev.assistantMessageEvent.delta });
        } else if (ev.type === 'turn_end') {
          push({ type: 'turn_end', stopReason: ev.message.stopReason ?? null });
          // agent.prompt 不 reject provider 错误：失败编码为 stopReason:'error' +
          // errorMessage。不转发的话客户端只会看到空白回复。
          if (ev.message.stopReason === 'error') {
            push({ type: 'error', message: ev.message.errorMessage ?? 'provider error' });
          } else if (!DIRTY_STOP_REASONS.has(ev.message.stopReason)) {
            // 成功的终结回合才落盘：把 Agent 眼中的完整对话（含本轮）原样存下——
            // 与 initialState.messages 同一形状，恢复时无需重整。cwd/provider/
            // model/title 由网关记（逐字段合并，两边不会互踩），适配器只写自己
            // 独有的字段。刻意不存「piSessionId / gatewaySessionId」之类：
            // Agent 构造用的 sessionId 就是网关的会话键，与记录 id 同值，存了
            // 只是重复；而它也不是 pi CLI 的 --session 句柄（库只把它转发给
            // provider，不写 ~/.pi/agent/sessions）——真正可 resume 的 CLI id
            // 由 Task 5 单独铸造并镜像，写在下面 save 的 piSessionId 里（已在
            // RECORD_FIELDS 白名单中）。失败/中止轮留占位 assistant 消息，
            // 与缓存逐出同一理由不落盘。
            //
            // cache=false 与播种对称：那趟是一次性 Agent，它的
            // transcript 只有本轮，若写进共享记录等于用单轮历史覆盖真会话。
            // 落盘失败只记日志：库会 await 监听器，这里抛出去会变成第二个
            // turn_end{stopReason:'error'} 并写上 state.errorMessage，进而被
            // run 末尾的错误清理逐出缓存——磁盘满一次就毁掉整个会话对话。
            if (transcripts && cache && sessionId) {
              try {
                const rec = transcripts.get(sessionId);
                // 会话标题：首条 user 消息的前 40 字。只在记录还没有标题时
                // 写一次——用户改过的标题不能被后续轮次冲掉（逐字段合并）。
                // 建会话那一刻还没有消息，标题由这里补上。
                const title = rec?.title ?? deriveTitle(agent.state.messages);
                transcripts.save({
                  id: sessionId, adapter: 'pi', agent: 'pi',
                  messages: withUsage(agent.state.messages),
                  ...(title ? { title } : {}),
                });
              } catch (err) {
                logErr('pi', `transcript save failed for ${sessionId}: ${err?.message ?? err}`);
              }
              // 镜像一份 pi CLI 原生格式到共享目录：本机
              //   pi --session-dir <共享目录> --session <piSessionId>
              // 就能打开这个会话。四条实测约束（2026-10-21，真实 pi CLI 0.84.3）：
              //   · 平铺在 piSessionDir 里——显式 --session-dir 时 CLI 非递归扫描
              //     （listSessionsFromDir 只 readdir 一层），放进 <cwdSlug>/ 子目录
              //     会 "No session found matching"；
              //   · piSessionId 首次生成后固定存进记录，同一个会话始终是同一个 id
              //     （网关的 sessionId 只被转发给 provider，与 CLI 会话 id 无关）；
              //   · 文件名固定（不含时间戳）→ 每轮覆写同一个文件，目录里不会堆 N 份副本；
              //   · assistant 的 usage 在 build 之前补零（缺失会让 CLI 崩在 totalTokens 上）。
              // 失败绝不影响回合——互通是增益，不是依赖。
              if (piSessionDir) {
                try {
                  const rec = transcripts.get(sessionId) ?? {};
                  const piSessionId = rec.piSessionId ?? randomUUID();
                  const lines = buildPiSessionLines({
                    piSessionId,
                    cwd: cwd ?? process.cwd(),
                    name: rec.title ?? 'AgentToolbox',
                    messages: withUsage(conversationMessages(agent.state.messages)),
                  });
                  mkdirSync(piSessionDir, { recursive: true, mode: 0o700 });
                  // 固定名：同一个会话始终这一个文件，每轮整体覆写。
                  // 0600：和 transcript 一个口径，里面是 full tier 的工具输出。
                  const file = join(piSessionDir, `${piSessionId}.jsonl`);
                  writeFileSync(file, renderPiSession(lines), { mode: 0o600 });
                  chmodSync(file, 0o600);
                  transcripts.save({ id: sessionId, piSessionId });
                } catch (err) {
                  logErr('pi:mirror', String(err?.message ?? err).slice(0, 120));
                }
              }
            }
          }
        }
      });

      // 外部中止（如 SSE 客户端断开）：把 AbortSignal 接到 agent.abort()。
      const onAbort = () => agent.abort?.();
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      // Promise.resolve().then 把 prompt 的同步抛错也变成 rejection，
      // 统一由 catch 转成 error 事件（而不是让 run() 直接 reject）。
      Promise.resolve()
        .then(() => agent.prompt(lastUserText(messages)))
        .catch((err) => push({ type: 'error', message: String(err?.message ?? err) }))
        .finally(() => { settled = true; notify(); });

      try {
        while (queue.length > 0 || !settled) {
          if (queue.length > 0) { yield queue.shift(); continue; }
          await new Promise((r) => { wake = r; });
        }
      } finally {
        // 生成器被提前 return()（调用方 break / 客户端断开）时本轮可能仍在跑：
        // 中止它，避免遗留后台推理。正常结束时进程已 idle，abort() 是 no-op。
        // abort() 只作用于 activeRun（finishRun 后为 undefined），因此「中止本轮」
        // 与「保留 transcript 供下一轮续用」并不冲突。
        agent.abort?.();
        signal?.removeEventListener('abort', onAbort);
        unsub();
        // 被中止/出错的一轮会留下一条占位 assistant 消息（空文本、stopReason 为
        // 'aborted'/'error'），下一轮带着它继续累积就是脏上下文。命中缓存与否都要判：
        // 首次发言就失败的 Agent 同样已被写进缓存（cached=false），只查 cached 会
        // 让它把失败轮带进下一次发言。逐出后该会话下次发言时从持久记录重新播种
        // （不是干净 transcript）——代价是可能丢掉逐出后那几轮，好过把失败轮喂给模型。
        // state.errorMessage 由 runWithLifecycle 在每轮开始时清零，成功轮不会误逐。
        if (cache && sessionId && agent.state?.errorMessage) agents.delete(sessionId);
      }
    },
    // 会话终结（TTL/容量逐出、客户端关抽屉）由 server 经 record.dispose 调到这里。
    // 只释放内存（LRU 里的 Agent 由 agents Map 自管，此处无需动作）——**不删**
    // transcript 记录：sessions.mjs 在 LRU 逐出时也会走 disposeSession，删了记录
    // 「逐出后重启还能恢复」就成了空话。磁盘回收只经由 store 的 remove()/sweep()。
    disposeSession() {},
    // 恢复材料：重启/逐出后由 server（Task 5 的接线）调用。返回 null 表示
    // 「没有诚实可恢复的历史」，上层开新会话——绝不拿空数组冒充历史。
    restore(sessionId) {
      const messages = loadPersistedMessages(sessionId);
      // 返回副本：store 里的数组是共享状态，调用方（Task 5 的接线）拿去改
      // 就等于就地改写了磁盘记录的内存视图。
      return messages ? { messages: [...messages] } : null;
    },
  };
}
