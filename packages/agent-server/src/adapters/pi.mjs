// pi 适配器：进程内 pi-agent-core 运行时的封装，事件转成统一契约
// （delta / turn_end / error），与 cc 适配器成为对等实现。
//
// Agent 按 sessionId 跨轮缓存——这是多轮上下文的唯一承载处：前端每轮只发
// `{ text }`，历史只能由服务端持有。Agent 的 transcript 是可变状态，每轮新建
// 一个 Agent 会让模型在第 2 轮只看到本轮那一句（回归已实测：见
// test/server.test.mjs 的 multi-turn 用例）。
import { Agent } from '@earendil-works/pi-agent-core';
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

function defaultMakeAgent(models, model, sessionId, apiKey) {
  return new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model },
    streamFn: (m, context, options) => models.streamSimple(m, context, {
      ...options,
      timeoutMs: STREAM_TIMEOUT_MS,
      fetch: longTimeoutFetch,
    }),
    sessionId,
    getApiKey: () => apiKey,
  });
}

export function createPiAdapter({ models, resolve, makeAgent = defaultMakeAgent, capacity = 16 } = {}) {
  // sessionId → { agent, cacheKey }。LRU 容量与 server 的 SessionStore 对齐（16），
  // 被淘汰的会话下一次发言会从空 transcript 重新开始（与「会话已被回收」同义）。
  const agents = new Map();
  // 缓存键必须覆盖 agent 身份的两个维度：换模型换 key 都得换 Agent（否则会把
  // 上一模型的上下文与凭据带过去）。只比较引用，不存 key 明文。
  const cacheKey = (model, apiKey) => `${model.provider}/${model.id}\u0000${apiKey ?? ''}`;

  function agentFor(model, sessionId, apiKey) {
    const key = cacheKey(model, apiKey);
    const hit = agents.get(sessionId);
    if (hit && hit.cacheKey === key) {
      agents.delete(sessionId);      // 重新插入 → 刷新 LRU 序
      agents.set(sessionId, hit);
      return hit.agent;
    }
    const agent = makeAgent(models, model, sessionId, apiKey);
    agents.delete(sessionId);
    agents.set(sessionId, { agent, cacheKey: key });
    while (agents.size > capacity) agents.delete(agents.keys().next().value);
    return agent;
  }

  return {
    id: 'pi',
    async available() { return true; },
    // cache=false → 本轮走一次性 Agent（不读也不写缓存），供不共享运行时状态的
    // 适配器进行 failover（例如 cc builder 失败后回落到 pi）。
    async *run({ messages, request, apiKey = null, sessionId, signal, cache = true } = {}) {
      const { model } = resolve(models, request);
      const agent = cache && sessionId
        ? agentFor(model, sessionId, apiKey)
        : makeAgent(models, model, sessionId, apiKey);

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
  };
}
