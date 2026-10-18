import { describe, expect, it } from 'vitest';
import { parseSSEChunk, keyFor, probeHealth, fetchOpenRouterQuota } from './agentchat';

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

describe('fetchOpenRouterQuota', () => {
  it('posts the key in the body and returns the quota shape', async () => {
    const original = globalThis.fetch;
    let captured: RequestInfo | undefined;
    globalThis.fetch = (async (input: RequestInfo) => {
      captured = input;
      return new Response(JSON.stringify({
        usage: 3, limit: 50, isFreeTier: true, rateLimit: { requests: '50' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const q = await fetchOpenRouterQuota('sk-or-x', 'http://x');
      expect(q).toEqual({ usage: 3, limit: 50, isFreeTier: true, rateLimit: { requests: '50' } });
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
