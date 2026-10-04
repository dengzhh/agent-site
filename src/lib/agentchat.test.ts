import { describe, expect, it } from 'vitest';
import { parseSSEChunk, keyFor } from './agentchat';

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
