// free-models.json provider id → pi-ai 内置工厂。github-copilot（OAuth）与
// deepinfra（无工厂）不在此表：前者前端不出 Chat 按钮，后者走动态回退。
import {
  createProvider, envApiKeyAuth,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { groqProvider } from '@earendil-works/pi-ai/providers/groq';
import { mistralProvider } from '@earendil-works/pi-ai/providers/mistral';
import { cerebrasProvider } from '@earendil-works/pi-ai/providers/cerebras';
import { nvidiaProvider } from '@earendil-works/pi-ai/providers/nvidia';
import { togetherProvider } from '@earendil-works/pi-ai/providers/together';
import { fireworksProvider } from '@earendil-works/pi-ai/providers/fireworks';
import { cloudflareWorkersAIProvider } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai';
import { opencodeProvider } from '@earendil-works/pi-ai/providers/opencode';
import { zaiProvider } from '@earendil-works/pi-ai/providers/zai';
import { qwenTokenPlanProvider } from '@earendil-works/pi-ai/providers/qwen-token-plan';

export const BUILTIN_FACTORIES = {
  openrouter: openrouterProvider,
  nvidia: nvidiaProvider,
  groq: groqProvider,
  mistral: mistralProvider,
  cerebras: cerebrasProvider,
  zai: zaiProvider,
  opencode: opencodeProvider,
  'cloudflare-workers-ai': cloudflareWorkersAIProvider,
  togetherai: togetherProvider,
  'fireworks-ai': fireworksProvider,
  'alibaba-token-plan': qwenTokenPlanProvider,
};

export class UnsupportedError extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedError'; }
}

const sanitize = (id) => id.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

/**
 * 解析 free-models 页发来的 {provider, model, baseUrl?, envKey?, name?,
 * contextWindow?, maxOutput?, apiKey?} 为 pi-ai Model，注册进 models 集合。
 * 返回 { model, providerId }。
 */
export function resolveModel(models, req) {
  if (!req.provider || !req.model) {
    throw new UnsupportedError(`provider and model are required`);
  }
  const factory = BUILTIN_FACTORIES[req.provider];
  // 无可用凭证（无 apiKey 且 envKey 未设/未配置）时跳过内置分支：所有内置 provider 都
  // 硬性要求 env key，无凭证时必抛 "Provider is not configured"。落到动态分支用占位 key
  // 放行 keyless 端点（opencode zen 等不校验鉴权头）。
  const hasCredential = Boolean(req.apiKey || (req.envKey && process.env[req.envKey]));
  if (factory && hasCredential) {
    const p = factory();
    models.setProvider(p);
    const found = models.getModel(p.id, req.model);
    // baseUrl 一致或未提供 → 用内置目录（env 鉴权 pi-ai 自动解析）
    if (found && (!req.baseUrl || found.baseUrl === req.baseUrl)) {
      return { model: found, providerId: p.id };
    }
  }
  if (req.baseUrl) {
    const pid = `atbx-${sanitize(req.provider)}`;
    const model = {
      id: req.model,
      name: req.name || req.model,
      api: 'openai-completions',
      provider: pid,
      baseUrl: req.baseUrl,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: req.contextWindow || 128000,
      maxTokens: req.maxOutput || 8192,
      reasoning: false,
    };
    // auth 三选一：显式 apiKey > 可用 env > 占位 key（keyless 端点不校验该头时免费可用）。
    // envKey 有值但 env 未设置时不能选 env 鉴权——resolve 返回 undefined 会报
    // "Provider is not configured"，keyless 体验就断了。
    const auth = req.apiKey
      ? { apiKey: { name: req.name || req.provider, resolve: async () => ({ auth: { apiKey: req.apiKey } }) } }
      : req.envKey && process.env[req.envKey]
        ? { apiKey: envApiKeyAuth(req.name || req.provider, [req.envKey]) }
        : { apiKey: { name: req.name || req.provider, resolve: async () => ({ auth: { apiKey: 'unused' } }) } };
    models.setProvider(createProvider({
      id: pid, name: req.name || req.provider, baseUrl: req.baseUrl,
      auth, models: [model], api: openAICompletionsApi(),
    }));
    return { model: models.getModel(pid, req.model), providerId: pid };
  }
  throw new UnsupportedError(`no builtin provider or baseUrl for "${req.provider}/${req.model}"`);
}
