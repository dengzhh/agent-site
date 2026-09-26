import type { FreeProvider, FreeModel } from './free-models';

export type ConfigTarget = 'claude-code' | 'codex' | 'env' | 'ai-sdk';

const KEY_PLACEHOLDER = 'YOUR_API_KEY';

// 已知专用 SDK 包 → 示例工厂代码；其余走 openai-compatible 通用形态
const DEDICATED_SDK: Record<string, (p: FreeProvider) => string> = {
  '@openrouter/ai-sdk-provider': (p) =>
    `import { createOpenRouter } from '@openrouter/ai-sdk-provider';\n\n` +
    `const ${p.id} = createOpenRouter({ apiKey: process.env.${p.envKey} });`,
};

export function generateConfig(
  target: ConfigTarget,
  provider: FreeProvider,
  model: FreeModel,
  apiKey: string,
): string {
  const key = (apiKey ?? '').trim() || KEY_PLACEHOLDER;

  if (target === 'env') {
    return `export ${provider.envKey}=${key}`;
  }

  if (target === 'claude-code') {
    if (provider.anthropicApi) {
      return [
        '// ~/.claude/settings.json',
        '{',
        '  "env": {',
        `    "ANTHROPIC_BASE_URL": "${provider.anthropicApi}",`,
        `    "ANTHROPIC_API_KEY": "${key}",`,
        `    "ANTHROPIC_MODEL": "${model.id}"`,
        '  }',
        '}',
      ].join('\n');
    }
    // OpenAI 协议 provider：不生成假配置，给出真实路径
    return [
      `# ${provider.name} speaks the OpenAI protocol, but Claude Code needs an`,
      '# Anthropic-compatible endpoint. Two real options:',
      '#',
      '# 1) Use claude-code-router (https://github.com/musistudio/claude-code-router)',
      `#    to translate: it reads OPENAI_API_BASE=${provider.api} and forwards to Claude Code.`,
      '#',
      '# 2) Pick a provider with a native Anthropic-compatible endpoint (marked',
      '#    "direct" in the table above), e.g. Z.ai GLM.',
      '#',
      '# Shell env for the router route (works today):',
      `export OPENAI_API_BASE=${provider.api}`,
      `export OPENAI_API_KEY=${key}`,
      `export OPENROUTER_MODEL=${model.id}`,
    ].join('\n');
  }

  if (target === 'codex') {
    const pid = provider.id.replace(/[^a-z0-9]/g, '_');
    return [
      '# ~/.codex/config.toml',
      `model = "${model.id}"`,
      `model_provider = "${pid}"`,
      '',
      `[model_providers.${pid}]`,
      `name = "${provider.name}"`,
      `base_url = "${provider.api}"`,
      'wire_api = "responses"',
      `env_key = "${provider.envKey}"`,
      '',
      `# then: export ${provider.envKey}=${key}`,
      '# note: the provider must support the OpenAI Responses API (wire_api',
      '# "chat" was removed from Codex in 2026). If it only offers',
      '# /chat/completions, route through a translating gateway (LiteLLM).',
    ].join('\n');
  }

  // ai-sdk
  const factory = provider.npm ? DEDICATED_SDK[provider.npm] : undefined;
  if (factory) {
    return [
      `// npm install ${provider.npm} ai`,
      factory(provider),
      `const result = await generateText({`,
      `  model: ${provider.id}('${model.id}'),`,
      `  prompt: 'Hello!',`,
      `});`,
    ].join('\n');
  }
  const varName = provider.id.replace(/[^a-z0-9]/g, '');
  return [
    '// npm install @ai-sdk/openai-compatible ai',
    `import { createOpenAICompatible } from '@ai-sdk/openai-compatible';`,
    '',
    `const ${varName} = createOpenAICompatible({`,
    `  name: '${provider.id}',`,
    `  baseURL: '${provider.api}',`,
    `  apiKey: process.env.${provider.envKey},`,
    `});`,
    '',
    `const result = await generateText({`,
    `  model: ${varName}.chatModel('${model.id}'),`,
    `  prompt: 'Hello!',`,
    `});`,
  ].join('\n');
}
