// pi 适配器：进程内 pi-agent-core 运行时的封装，事件转成统一契约
// （delta / turn_end / error），与 cc 适配器成为对等实现。
//
// Agent 按 sessionId 跨轮缓存——这是多轮上下文的唯一承载处：前端每轮只发
// `{ text }`，历史只能由服务端持有。Agent 的 transcript 是可变状态，每轮新建
// 一个 Agent 会让模型在第 2 轮只看到本轮那一句（回归已实测：见
// test/server.test.mjs 的 multi-turn 用例）。
import { Agent } from '@earendil-works/pi-agent-core';
import { readOnlyTools, fullTools } from './pi-tools.mjs';
// 免费模型推理排队慢（OpenRouter 免费档高峰可等数分钟），OpenAI SDK 默认 10 分钟超时
// 会被 undici 的 300s headersTimeout 先打断（"Request timed out"）。修法两层：
// ① streamSimple 传大 timeoutMs（SDK 侧）；② 传 undici 包的 fetch + 长超时 dispatcher
// （传输层——SDK 用全局 fetch 时其内置 undici 的 300s headersTimeout 无法配置）。
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';

const SYSTEM_PROMPT = 'You are a helpful assistant chatting in the AgentToolbox web app. Be concise and useful.';
const STREAM_TIMEOUT_MS = 15 * 60_000;

const streamDispatcher = new UndiciAgent({
  headersTimeout: STREAM_TIMEOUT_MS,
  bodyTimeout: STREAM_TIMEOUT_MS,
});
const longTimeoutFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: streamDispatcher });

// 取最后一条 user 消息的文本作为本轮 prompt，与 server.mjs 的
// `body.text` / cc 适配器的 lastUserText 语义一致。
function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return String(messages[i].content ?? '');
  }
  return '';
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

export function createPiAdapter({ models, resolve, makeAgent = defaultMakeAgent, capacity = 16, transcripts = null } = {}) {
  // sessionId → { agent, cacheKey }。LRU 容量与 server 的 SessionStore 对齐（16），
  // 被淘汰的会话下一次发言会从空 transcript 重新开始（与「会话已被回收」同义）。
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

  // 残缺的 usage 不能落盘：pi CLI resume 读 usage.totalTokens，缺字段直接崩
  // （"Cannot read properties of undefined (reading 'totalTokens')"，已实测）。
  // 整个剥掉而不是补零——省略 usage 是安全的，伪造的 usage 不是。
  function stripPartialUsage(messages) {
    return messages.map((m) => {
      if (m.role !== 'assistant' || m.usage === undefined
        || (typeof m.usage === 'object' && m.usage !== null && Number.isFinite(m.usage.totalTokens))) {
        return m;
      }
      const { usage: _partial, ...rest } = m;
      return rest;
    });
  }

  // 从 store 取恢复材料。只有 adapter 字段也对得上才认：pi 拿 cc 的历史去
  // 播种，模型看到的会是一份自己没说过的「回复」，比丢历史更糟。
  function restoreMessages(sessionId) {
    if (!transcripts || !sessionId) return null;
    const rec = transcripts.get(sessionId);
    if (rec?.adapter !== 'pi' || !Array.isArray(rec.messages) || rec.messages.length === 0) return null;
    return rec.messages;
  }

  return {
    id: 'pi',
    async available() { return true; },
    // cache=false → 本轮走一次性 Agent（不读也不写缓存），供不共享运行时状态的
    // 适配器进行 failover（例如 cc builder 失败后回落到 pi）。
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
      // （failover 路径）刻意不播种：那趟运行不写缓存也不该读共享历史。
      const restored = !cached && cache && sessionId ? restoreMessages(sessionId) : null;
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
          push({ type: 'turn_end', stopReason: ev.message.stopReason ?? null, sessionId });
          // agent.prompt 不 reject provider 错误：失败编码为 stopReason:'error' +
          // errorMessage。不转发的话客户端只会看到空白回复。
          if (ev.message.stopReason === 'error') {
            push({ type: 'error', message: ev.message.errorMessage ?? 'provider error' });
          } else {
            // 成功的终结回合才落盘：把 Agent 眼中的完整对话（含本轮）原样存下——
            // 与 initialState.messages 同一形状，恢复时无需重整。cwd/provider/
            // model/title 由网关记（逐字段合并，两边不会互踩），适配器只写自己
            // 独有的字段。piSessionId 就是 Agent 构造时用的 sessionId（库把它
            // 作为 provider 侧的会话标识），记录里存一份供 Task 5 镜像到
            // ~/.pi/agent/sessions 时对得上号。失败/中止轮留脏上下文，与缓存
            // 逐出同一理由不落盘。
            if (transcripts && sessionId && Array.isArray(agent.state?.messages)) {
              transcripts.save({
                id: sessionId, adapter: 'pi', agent: 'pi',
                piSessionId: sessionId,
                messages: stripPartialUsage(agent.state.messages),
              });
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
        // 让它把失败轮带进下一次发言。逐出后该会话从干净 transcript 重开——代价是
        // 上下文丢失（客户端已收到 error 帧），好过把失败轮喂给模型。
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
      const messages = restoreMessages(sessionId);
      return messages ? { messages } : null;
    },
  };
}
