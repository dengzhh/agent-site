import { describe, expect, it } from 'vitest';
import { parseSSEChunk, keyFor, probeHealth, createSession, fetchOpenRouterQuota, formatQuota, answerPermission, type OpenRouterQuota } from './agentchat';

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
