import type { FreeProvider, FreeModel } from './free-models';

export type ConfigTarget = 'claude-code' | 'codex' | 'env' | 'ai-sdk';

const KEY_PLACEHOLDER = 'YOUR_API_KEY';

// 已知专用 SDK 包 → 示例工厂代码；其余走 openai-compatible 通用形态
const DEDICATED_SDK: Record<string, (p: FreeProvider) => string> = {
  '@openrouter/ai-sdk-provider': (p) =>
    `import { createOpenRouter } from '@openrouter/ai-sdk-provider';\n\n` +
    `const ${p.id} = createOpenRouter({ apiKey: process.env.${p.envKey} });`,
  '@ai-sdk/groq': (p) =>
    `import { createGroq } from '@ai-sdk/groq';\n\n` +
    `const ${p.id} = createGroq({ apiKey: process.env.${p.envKey} });`,
  '@ai-sdk/mistral': (p) =>
    `import { createMistral } from '@ai-sdk/mistral';\n\n` +
    `const ${p.id} = createMistral({ apiKey: process.env.${p.envKey} });`,
};

// 数据里没有公开 API base URL 时，禁止产出 base_url = "null" 之类的死配置
function nullApiNotice(provider: FreeProvider, comment: '#' | '//'): string {
  const where = provider.doc ?? "the provider's official website";
  return [
    `${comment} No public API base URL in our data for ${provider.name}.`,
    `${comment} Check ${where} for the current base URL, then configure manually.`,
  ].join('\n');
}

// TOML 基本字符串的最小转义
function tomlStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function generateConfig(
  target: ConfigTarget,
  provider: FreeProvider,
  model: FreeModel,
  apiKey: string,
): string {
  const key = (apiKey ?? '').trim() || KEY_PLACEHOLDER;

  if (target === 'env') {
    return `export ${provider.envKey}="${key}"`;
  }

  if (target === 'claude-code') {
    if (provider.anthropicApi) {
      // 纯 JSON 片段（无注释，可整段粘贴）；路径提示放在 JSON 之后的 # 行
      return [
        JSON.stringify(
          {
            env: {
              ANTHROPIC_BASE_URL: provider.anthropicApi,
              ANTHROPIC_AUTH_TOKEN: key,
              ANTHROPIC_MODEL: model.id,
              ANTHROPIC_DEFAULT_HAIKU_MODEL: model.id,
            },
          },
          null,
          2,
        ),
        '# Save as ~/.claude/settings.json (merge the env block into existing settings)',
      ].join('\n');
    }
    if (provider.api == null) {
      return nullApiNotice(provider, '#');
    }
    // OpenAI 协议 provider：不生成假配置，走 claude-code-router 翻译
    return [
      `# ${provider.name} speaks the OpenAI protocol, but Claude Code needs an`,
      '# Anthropic-compatible endpoint. Real path: claude-code-router.',
      '#',
      '# 1) npm install -g @musistudio/claude-code-router',
      '# 2) Create ~/.claude-code-router/config.json:',
      '#',
      '{',
      '  "Providers": [',
      '    {',
      `      "name": "${provider.id}",`,
      `      "api_base_url": "${provider.api}/chat/completions",`,
      `      "api_key": "${key}",`,
      `      "models": ["${model.id}"]`,
      '    }',
      '  ],',
      '  "Router": {',
      `    "default": "${provider.id},${model.id}"`,
      '  }',
      '}',
      '#',
      '# 3) Start with `ccr code`; after editing the config run `ccr restart`.',
      '#',
      '# Alternatively pick a provider with a native Anthropic-compatible',
      '# endpoint (marked "direct"), e.g. Z.ai GLM.',
    ].join('\n');
  }

  if (target === 'codex') {
    if (provider.api == null) {
      return nullApiNotice(provider, '#');
    }
    const pid = provider.id.replace(/[^a-z0-9]/g, '_');
    return [
      '# merge into ~/.codex/config.toml',
      `model = "${tomlStr(model.id)}"`,
      `model_provider = "${pid}"`,
      '',
      `[model_providers.${pid}]`,
      `name = "${tomlStr(provider.name)}"`,
      `base_url = "${tomlStr(provider.api)}"`,
      'wire_api = "responses"',
      `env_key = "${provider.envKey}"`,
      '',
      `# then: export ${provider.envKey}="${key}"`,
      `# note: Codex requires the OpenAI Responses API; if ${provider.name} only`,
      '# offers /chat/completions, route through a translating gateway (LiteLLM).',
    ].join('\n');
  }

  // ai-sdk：专用 SDK 不需要 baseURL（groq/mistral 的 api 在数据里就是 null）
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
  if (provider.api == null) {
    return nullApiNotice(provider, '//');
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
