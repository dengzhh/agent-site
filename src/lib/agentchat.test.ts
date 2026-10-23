import { describe, expect, it } from 'vitest';
import { parseSSEChunk, keyFor, probeHealth, createSession, releaseSession, releaseSessionQueued, awaitPendingRelease, fetchOpenRouterQuota, formatQuota, answerPermission, historyBlocks, sessionModelLabel, type OpenRouterQuota } from './agentchat';


describe('parseSSEChunk', () => {
  it('parses complete blocks and keeps partial in rest', () => {
    const { events, rest } = parseSSEChunk('data: {"type":"delta","text":"a"}\n\ndata: {"type":"del');
    expect(events).toEqual([{ type: 'delta', text: 'a' }]);
    expect(rest).toBe('data: {"type":"del');
  });
  it('skips comments and invalid JSON', () => {
    const { events } = parseSSEChunk(': ping\n\ndata: not-json\n\ndata: {"type":"done"}\n\n');
    expect(events).toEqual([{ type: 'done' }]);
  });
  it('joins multi-line data blocks', () => {
    const { events } = parseSSEChunk('data: {"type":"delta",\ndata: "text":"x"}\n\n');
    expect(events).toEqual([{ type: 'delta', text: 'x' }]);
  });
});

describe('keyFor', () => {
  it('namespaces per provider', () => {
    expect(keyFor('groq')).toBe('atbx:key:groq');
  });
});

describe('probeHealth', () => {
  it('probeHealth surfaces agent availability', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: true, version: '0.2.0', grantedDirs: [], agents: [{ id: 'cc', available: false }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      const h = await probeHealth('http://x');
      expect(h?.agents?.[0]).toEqual({ id: 'cc', available: false });
    } finally { globalThis.fetch = original; }
  });
});

describe('createSession', () => {
  it('returns the whole SessionResponse body, not just the id', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      sessionId: 's-1', adapter: 'pi', provider: 'openrouter', model: 'q/free',
      cwd: '/tmp/proj', toolTier: 'read',
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      const s = await createSession({ provider: 'openrouter', model: 'q/free', cwd: '/tmp/proj', toolTier: 'read' }, 'http://x');
      expect(s).toEqual({
        sessionId: 's-1', adapter: 'pi', provider: 'openrouter', model: 'q/free',
        cwd: '/tmp/proj', toolTier: 'read',
      });
    } finally { globalThis.fetch = original; }
  });
});

describe('fetchOpenRouterQuota', () => {
  it('posts the key in the body and returns the quota shape', async () => {
    const original = globalThis.fetch;
    let captured: RequestInfo | undefined;
    globalThis.fetch = (async (input: RequestInfo) => {
      captured = input;
      // fetchOpenRouterQuota 拿的是网关已经投影过的响应，不是上游原始形状
      return new Response(JSON.stringify({
        creditsUsed: 25.5, creditLimit: 100, creditRemaining: 74.5,
        isFreeTier: false, freeRequests: 1000, freeUsed: 12, freeRemaining: 988,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const q = await fetchOpenRouterQuota('sk-or-x', 'http://x');
      expect(q).toEqual({
        creditsUsed: 25.5, creditLimit: 100, creditRemaining: 74.5,
        isFreeTier: false, freeRequests: 1000, freeUsed: 12, freeRemaining: 988,
      });
      expect(String(captured)).toBe('http://x/quota/openrouter');
    } finally { globalThis.fetch = original; }
  });
  it('returns null on non-2xx and on network failure', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"error":"upstream error"}', { status: 502 })) as typeof fetch;
    try { expect(await fetchOpenRouterQuota('k', 'http://x')).toBeNull(); }
    finally { globalThis.fetch = original; }
    globalThis.fetch = (async () => { throw new Error('down'); }) as typeof fetch;
    try { expect(await fetchOpenRouterQuota('k', 'http://x')).toBeNull(); }
    finally { globalThis.fetch = original; }
  });
});

// 文案是否真实：这里钉的是"不许编造"，而不只是字符串长什么样。
// 上一版实现正是靠硬编码 '免费档 50/天' 和把 credits 说成"请求/天"骗过了所有测试。
describe('formatQuota', () => {
  const quota = (over: Partial<OpenRouterQuota> = {}): OpenRouterQuota => ({
    creditsUsed: null, creditLimit: null, creditRemaining: null,
    isFreeTier: null, freeRequests: null, freeUsed: null, freeRemaining: null,
    ...over,
  });

  it('reports the real daily ceiling instead of a hardcoded 50', () => {
    // 买过 ≥10 credits 的账号是 1000/天，50 只是没买够的那档
    expect(formatQuota(quota({ freeRequests: 1000, freeUsed: 12 })))
      .toBe('免费模型 今日 12/1000 次 · 余额 未知');
    expect(formatQuota(quota({ freeRequests: 50, freeUsed: 50 })))
      .toBe('免费模型 今日 50/50 次 · 余额 未知');
  });

  // 回归测试：本站曾由 isFreeTier === true 直接印出 '免费档 50/天'。
  // 官方口径是限额由累计购买 credits 决定、与 isFreeTier 无关，故该推断恒不成立。
  it('never infers the daily ceiling from isFreeTier', () => {
    const text = formatQuota(quota({ isFreeTier: true }));
    expect(text).not.toMatch(/50/);
    expect(text).toContain('未知');
  });

  // credits 是钱，不是请求数。写成"请求/天"等于把余额报成次数。
  it('labels credits as credits, not requests', () => {
    const text = formatQuota(quota({ creditLimit: 100, creditRemaining: 74.5 }));
    expect(text).toBe('免费模型限额 未知 · 余额 74.5/100 credits');
    expect(text).not.toMatch(/请求/);
  });

  it('falls back to used-credits, and to 未知 when nothing is known', () => {
    expect(formatQuota(quota({ creditsUsed: 25.5 }))).toContain('已用 25.5 credits');
    expect(formatQuota(quota())).toBe('免费模型限额 未知 · 余额 未知');
  });

  // 0 是合法数字（真用完了/真没余额），不能被当成"未知"或反过来被当成缺失
  it('distinguishes a real 0 from unknown', () => {
    expect(formatQuota(quota({ freeRequests: 50, freeUsed: 0 }))).toContain('今日 0/50');
    expect(formatQuota(quota({ creditRemaining: 0, creditLimit: 100 }))).toContain('余额 0/100');
  });
});

describe('new ACP event kinds', () => {
  it('parses a thinking frame', () => {
    const { events } = parseSSEChunk('data: {"type":"thinking","text":"hmm"}\n\n');
    expect(events).toEqual([{ type: 'thinking', text: 'hmm' }]);
  });
  it('parses a usage frame', () => {
    const { events } = parseSSEChunk('data: {"type":"usage","usage":{"used":10,"size":200000}}\n\n');
    expect(events).toEqual([{ type: 'usage', usage: { used: 10, size: 200000 } }]);
  });
  it('parses an activity frame', () => {
    const { events } = parseSSEChunk('data: {"type":"activity","title":"Read file"}\n\n');
    expect(events).toEqual([{ type: 'activity', title: 'Read file' }]);
  });
});

describe('permission_request', () => {
  it('parses a permission frame into the typed event', () => {
    // 网关 encodeSSE 把 type 拼在 payload 之后：data: {"reqId":...,"type":"permission_request"}
    const { events } = parseSSEChunk(
      'data: {"reqId":"r-1","action":"bash","summary":"npm test","type":"permission_request"}\n\n',
    );
    expect(events).toEqual([
      { type: 'permission_request', reqId: 'r-1', action: 'bash', summary: 'npm test' },
    ]);
  });
});

describe('answerPermission', () => {
  it('posts reqId + decision to the permission endpoint and resolves true on 2xx', async () => {
    const original = globalThis.fetch;
    let captured: RequestInfo | undefined;
    let body: string | undefined;
    globalThis.fetch = (async (input: RequestInfo, init?: RequestInit) => {
      captured = input;
      body = init?.body as string;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      expect(await answerPermission('s-1', 'r-1', true, 'http://x')).toBe(true);
      expect(String(captured)).toBe('http://x/sessions/s-1/permission');
      expect(body).toBe('{"reqId":"r-1","decision":"allow"}');
      expect(await answerPermission('s-1', 'r-2', false, 'http://x')).toBe(true);
      expect(body).toBe('{"reqId":"r-2","decision":"deny"}');
    } finally { globalThis.fetch = original; }
  });
  it('resolves false on 404 (timed out / already settled) and on network failure', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"error":"unknown permission request"}', { status: 404 })) as typeof fetch;
    try { expect(await answerPermission('s-1', 'r-1', true, 'http://x')).toBe(false); }
    finally { globalThis.fetch = original; }
    globalThis.fetch = (async () => { throw new Error('down'); }) as typeof fetch;
    try { expect(await answerPermission('s-1', 'r-1', true, 'http://x')).toBe(false); }
    finally { globalThis.fetch = original; }
  });
});

// ── 恢复历史的渲染分流（2026-10-23）──────────────────────────────────────
// cc 的历史现在会进网页（见网关 cc.restore）。恢复渲染循环此前把非 text 块
// 画成 `[${blk.type}]`，思维链于是显示成 `[thinking]`。用户已确认选 A：
// 思维链与正文都显示，与 CLI 一致。逻辑提成纯函数，页面只负责接线——
// .astro 里的脚本 import 不进来，node 环境也没有 DOM。
describe('historyBlocks', () => {
  it('splits thinking from text and keeps the original order', () => {
    const blocks = [
      { type: 'thinking', thinking: '先想清楚' },
      { type: 'text', text: '好的' },
    ];
    expect(historyBlocks(blocks)).toEqual([
      { kind: 'thinking', text: '先想清楚' },
      { kind: 'text', text: '好的' },
    ]);
  });

  it('keeps string content as one text block', () => {
    expect(historyBlocks('plain')).toEqual([{ kind: 'text', text: 'plain' }]);
  });

  it('labels images and unknown blocks without inventing content', () => {
    expect(historyBlocks([{ type: 'image' }, { type: 'tool_use' }])).toEqual([
      { kind: 'image', text: '[图片]' },
      { kind: 'unknown', text: '[tool_use]' },
    ]);
  });

  it('keeps unknown blocks to a bare type label, leaking no field values', () => {
    // 真实 tool_use 带 id/name/input，redacted_thinking 带 data——都只报类型名，
    // 字段值一个不外带（不编内容，也不替用户把敏感值画上屏）。
    expect(historyBlocks([
      { type: 'tool_use', id: 'toolu_secret', name: 'Bash', input: { cmd: 'rm -rf /' } },
      { type: 'redacted_thinking', data: 's3cret' },
    ])).toEqual([
      { kind: 'unknown', text: '[tool_use]' },
      { kind: 'unknown', text: '[redacted_thinking]' },
    ]);
  });

  it('skips blocks it cannot say anything about', () => {
    expect(historyBlocks([null, {}, { type: 'text' }])).toEqual([
      { kind: 'text', text: '' },
    ]);
  });

  it('skips raw non-object entries in the array', () => {
    // 守卫 `typeof blk === 'object'`：字符串/数字混进数组时直接跳过，不硬画。
    expect(historyBlocks(['str', 42, { type: 'text', text: 'ok' }])).toEqual([
      { kind: 'text', text: 'ok' },
    ]);
  });
});

// 筛选不再按模型分格，列表里会混着不同模型的会话——标出来才知道这条
// 上次是谁跑的（记录里本来就有 model 字段）。
describe('sessionModelLabel', () => {
  it('shows the model when known', () => {
    expect(sessionModelLabel({ model: 'glm-4.7-flash' })).toBe('glm-4.7-flash');
  });
  it('says nothing rather than guessing when the record has no model', () => {
    expect(sessionModelLabel({ model: '' })).toBe('');
    expect(sessionModelLabel({})).toBe('');
  });
});

describe('releaseSession', () => {
  // 这条盯着「换模型后历史不变」的最后一块：网关侧占着旧会话不放，前端就只能
  // 撞 409 转开新对话。请求必须真的发出去（方法 + 路径 + id 编码），否则页面
  // 「看起来改了」而时序毫无变化。
  it('posts to /sessions/:id/release', async () => {
    const original = globalThis.fetch;
    let url = ''; let method = '';
    globalThis.fetch = (async (u: RequestInfo, init?: RequestInit) => {
      url = String(u); method = init?.method ?? 'GET';
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      await releaseSession('abc 123', 'http://gw');
      expect(method).toBe('POST');
      expect(url).toBe('http://gw/sessions/abc%20123/release');
    } finally { globalThis.fetch = original; }
  });

  // 网关对「本来就没在占用」也回 204；前端在每条作废路径上都发它，失败若往上抛
  // 会让 resetSession 的调用链炸掉（它不 catch），所以必须静默。
  it('swallows a failed release', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('gateway down'); }) as typeof fetch;
    try {
      await expect(releaseSession('s-1', 'http://gw')).resolves.toBeUndefined();
    } finally { globalThis.fetch = original; }
  });
});

describe('release → resume ordering', () => {
  // 这三条盯着换模型竞态的最后一环：三条作废路径（resetSession / openChat /
  // 关抽屉）都是同步函数，await 不了，所以 release 的 promise 被寄起来，
  // 由建会话前的那一刻等它。不等的话 POST /sessions{persistId} 可能先打到
  // 网关 → 409 → 前端误报「另一个标签页」并转开新对话，历史照样不出现。

  it('awaits a queued release before resuming', async () => {
    const original = globalThis.fetch;
    let released = false;
    let sawSessionBeforeRelease = false;
    // release 的响应压在 50ms 后：不等它，紧接着的 createSession 就会跑到前面去
    globalThis.fetch = (async (u: RequestInfo) => {
      const url = String(u);
      if (url.endsWith('/release')) {
        await new Promise((r) => setTimeout(r, 50));
        released = true;
        return new Response(null, { status: 204 });
      }
      if (url === 'http://gw/sessions') {
        sawSessionBeforeRelease = !released;
        return new Response(JSON.stringify({ sessionId: 's-2' }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      releaseSessionQueued('s-1', 'http://gw');
      await awaitPendingRelease();
      await createSession({ provider: 'p', model: 'm', persistId: 's-1' }, 'http://gw');
      expect(released).toBe(true);
      expect(sawSessionBeforeRelease).toBe(false);
    } finally { globalThis.fetch = original; }
  });

  // 没有待办的 release 时不许卡住：冷启动、点「新对话」这些路径不该凭空多一次
  // 往返，更不能把 awaitPendingRelease 变成建会话的前置阻塞。
  it('does not stall when nothing was queued', async () => {
    await expect(awaitPendingRelease()).resolves.toBeUndefined();
  });

  // 登记要真的把请求发出去（不是只存个标记），否则闸门等的是一个空操作。
  it('queues the release request itself', async () => {
    const original = globalThis.fetch;
    let url = ''; let method = '';
    globalThis.fetch = (async (u: RequestInfo, init?: RequestInit) => {
      url = String(u); method = init?.method ?? 'GET';
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      releaseSessionQueued('abc 123', 'http://gw');
      await awaitPendingRelease();
      expect(method).toBe('POST');
      expect(url).toBe('http://gw/sessions/abc%20123/release');
    } finally { globalThis.fetch = original; }
  });

  // 连点 A→B→A：第二个 release 在第一个还没回来时就登记。只存「最后一个」
  // 的实现会把第一个盖掉——那个请求照样打到网关、却没人等它，于是下一次恢复
  // 仍可能抢先撞 409（正是这条闸门要消灭的竞态，只是在更快的操作下复现）。
  // 两次释放的延迟故意差一个量级：一样快的话，没被等的那次也会在等待期间
  // 自行落地，测试就什么都证明不了（第一次写成就这样，变异后依然全绿）。
  it('awaits every queued release, not only the last one', async () => {
    const original = globalThis.fetch;
    const released: string[] = [];
    let sawSessionBeforeAllReleased = false;
    globalThis.fetch = (async (u: RequestInfo) => {
      const url = String(u);
      const rel = url.match(/^http:\/\/gw\/sessions\/(.+)\/release$/);
      if (rel) {
        const id = decodeURIComponent(rel[1]);
        await new Promise((r) => setTimeout(r, id === 'slow' ? 80 : 5));
        released.push(id);
        return new Response(null, { status: 204 });
      }
      if (url === 'http://gw/sessions') {
        sawSessionBeforeAllReleased = released.length < 2;
        return new Response(JSON.stringify({ sessionId: 's-3' }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      releaseSessionQueued('slow', 'http://gw');
      releaseSessionQueued('fast', 'http://gw');
      await awaitPendingRelease();
      await createSession({ provider: 'p', model: 'm', persistId: 'fast' }, 'http://gw');
      // 顺序无关（谁先回到本地看各自的延迟），数量与时机才是承诺
      expect(released.sort()).toEqual(['fast', 'slow']);
      expect(sawSessionBeforeAllReleased).toBe(false);
    } finally { globalThis.fetch = original; }
  });

  // 等待期间新登记的 release 属于下一轮建会话，该由它自己等：这一轮追着等会把
  // awaitPendingRelease 变成没有终点的手风琴（每次等完又有新的在飞）。
  it('leaves releases queued during the wait to the next round', async () => {
    const original = globalThis.fetch;
    const released: string[] = [];
    // 装在对象里：直接 `let releaseLate` 会被 TS 按闭包外的唯一赋值窄成 null
    const late: { go: (() => void) | null } = { go: null };
    globalThis.fetch = (async (u: RequestInfo) => {
      const url = String(u);
      const rel = url.match(/^http:\/\/gw\/sessions\/(.+)\/release$/);
      if (rel) {
        const id = decodeURIComponent(rel[1]);
        if (id === 'late') { await new Promise<void>((r) => { late.go = r; }); released.push(id); return new Response(null, { status: 204 }); }
        released.push(id);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      releaseSessionQueued('first', 'http://gw');
      const waiting = awaitPendingRelease();
      releaseSessionQueued('late', 'http://gw'); // 等待期间又登记了一个
      await waiting; // 只等 first：这一轮不能被子孙辈拖住
      expect(released).toEqual(['first']);
      late.go?.(); // 放走 late，别把测试挂在未 settle 的 promise 上
      await new Promise((r) => setTimeout(r, 0));
    } finally { globalThis.fetch = original; }
  });
});
