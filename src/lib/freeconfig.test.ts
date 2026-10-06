import { describe, it, expect } from 'vitest';
import { generateConfig, type ConfigTarget } from './freeconfig';
import type { FreeProvider, FreeModel } from './free-models';

const orProvider: FreeProvider = {
  id: 'openrouter', name: 'OpenRouter', api: 'https://openrouter.ai/api/v1',
  envKey: 'OPENROUTER_API_KEY', npm: '@openrouter/ai-sdk-provider',
  doc: 'https://openrouter.ai/docs', note: 'rate-limited', anthropicApi: null,
  models: [],
};
const zaiProvider: FreeProvider = {
  ...orProvider, id: 'zai', name: 'Z.ai', api: 'https://api.z.ai/api/paas/v4',
  envKey: 'ZHIPU_API_KEY', npm: null, anthropicApi: 'https://api.z.ai/api/anthropic',
};
const groqProvider: FreeProvider = {
  ...orProvider, id: 'groq', name: 'Groq', api: null,
  envKey: 'GROQ_API_KEY', npm: '@ai-sdk/groq',
  doc: 'https://console.groq.com/docs/models',
};
const gemma: FreeModel = {
  id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (free)', context: 262144,
  maxOutput: 32768, toolCall: true, reasoning: true, attachment: true,
  openWeights: true, lastUpdated: '2026-04-02',
  agents: ['cc', 'pi'],
};

describe('generateConfig', () => {
  it('claude-code: direct settings for anthropic-compatible provider', () => {
    const out = generateConfig('claude-code', zaiProvider, { ...gemma, id: 'glm-4.5-flash' }, 'sk-test');
    expect(out).toContain('"ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic"');
    expect(out).toContain('"ANTHROPIC_AUTH_TOKEN": "sk-test"');
    expect(out).toContain('"ANTHROPIC_MODEL": "glm-4.5-flash"');
  });

  it('claude-code: direct auth uses ANTHROPIC_AUTH_TOKEN (not API_KEY) plus haiku fallback', () => {
    const out = generateConfig('claude-code', zaiProvider, { ...gemma, id: 'glm-4.5-flash' }, 'sk-test');
    expect(out).toContain('"ANTHROPIC_AUTH_TOKEN": "sk-test"');
    expect(out).not.toContain('ANTHROPIC_API_KEY');
    expect(out).toContain('"ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-flash"');
  });

  it('claude-code: openai-protocol provider gets router guidance, no fake config', () => {
    const out = generateConfig('claude-code', orProvider, gemma, 'sk-or-test');
    expect(out).toContain('claude-code-router');
    expect(out).toContain('~/.claude-code-router/config.json');
    expect(out).toContain('"api_base_url": "https://openrouter.ai/api/v1/chat/completions"');
    expect(out).toContain('ccr code');
    expect(out).toContain('ccr restart');
    expect(out).not.toContain('"ANTHROPIC_BASE_URL": "https://openrouter.ai');
    expect(out).not.toContain('OPENROUTER_MODEL=');
  });

  it('codex: toml with wire_api responses', () => {
    const out = generateConfig('codex', orProvider, gemma, 'sk-or-test');
    expect(out).toContain('model = "google/gemma-4-31b-it:free"');
    expect(out).toContain('wire_api = "responses"');
    expect(out).toContain('https://openrouter.ai/api/v1');
    expect(out).toContain('# merge into ~/.codex/config.toml');
  });

  it('codex: provider without public api gets guidance, not dead config', () => {
    const out = generateConfig('codex', groqProvider, gemma, 'sk-groq');
    expect(out).toContain('No public API base URL');
    expect(out).toContain('https://console.groq.com/docs/models');
    expect(out).not.toContain('base_url = "null"');
    expect(out).not.toContain('wire_api');
  });

  it('env: export with provider env key, quoted value', () => {
    const out = generateConfig('env', orProvider, gemma, 'sk-or-test');
    expect(out).toContain('export OPENROUTER_API_KEY="sk-or-test"');
  });

  it('env: empty key falls back to quoted placeholder', () => {
    const out = generateConfig('env', orProvider, gemma, '');
    expect(out).toContain('export OPENROUTER_API_KEY="YOUR_API_KEY"');
  });

  it('ai-sdk: dedicated snippet for known npm package', () => {
    const out = generateConfig('ai-sdk', orProvider, gemma, undefined as unknown as string);
    expect(out).toContain("@openrouter/ai-sdk-provider");
    expect(out).toContain("openrouter('google/gemma-4-31b-it:free')");
  });

  it('ai-sdk: generic openai-compatible fallback', () => {
    const p = { ...zaiProvider, npm: null };
    const out = generateConfig('ai-sdk', p, { ...gemma, id: 'glm-4.5-flash' }, '');
    expect(out).toContain('@ai-sdk/openai-compatible');
    expect(out).toContain('https://api.z.ai/api/paas/v4');
  });

  it('ai-sdk: never embeds key into sample (env ref instead)', () => {
    const out = generateConfig('ai-sdk', orProvider, gemma, 'sk-secret');
    expect(out).not.toContain('sk-secret');
    expect(out).toContain('process.env.OPENROUTER_API_KEY');
  });
});
