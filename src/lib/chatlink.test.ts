import { describe, it, expect } from 'vitest';
import { parseOpenChatParams, parseOpenConfigParams } from './chatlink';

describe('parseOpenChatParams', () => {
  it('parses chat/model/name/ctx/maxout', () => {
    expect(parseOpenChatParams('?chat=openrouter&model=z-ai/glm-5.3&name=GLM&ctx=131072&maxout=65536'))
      .toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.3', name: 'GLM', ctx: 131072, maxout: 65536 });
  });
  it('defaults ctx/maxout to 0 and name to undefined when absent', () => {
    expect(parseOpenChatParams('?chat=openrouter&model=m'))
      .toEqual({ provider: 'openrouter', model: 'm', name: undefined, ctx: 0, maxout: 0 });
  });
  it('returns null without chat or model', () => {
    expect(parseOpenChatParams('?chat=openrouter')).toBeNull();
    expect(parseOpenChatParams('?model=m')).toBeNull();
    expect(parseOpenChatParams('')).toBeNull();
  });
  it('treats non-numeric ctx/maxout as 0 instead of NaN', () => {
    // strict 下 parse 可能返回 null：用 ?. 保 tsc 干净，真返回 null 时 toBe 照样失败
    expect(parseOpenChatParams('?chat=openrouter&model=m&ctx=abc&maxout=')?.ctx).toBe(0);
  });
});

describe('parseOpenConfigParams', () => {
  it('parses configure/model/name', () => {
    expect(parseOpenConfigParams('?configure=openrouter&model=m&name=M'))
      .toEqual({ provider: 'openrouter', model: 'm', name: 'M' });
  });
  it('returns null without configure or model', () => {
    expect(parseOpenConfigParams('?configure=openrouter')).toBeNull();
    expect(parseOpenConfigParams('')).toBeNull();
  });
});
