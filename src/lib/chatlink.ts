// /paid-models 的 Chat/Configure 按钮是跨页链接：免费页加载时解析 query 调已有
// openChat()/openConfig()（抽屉只此一份，不复制）。解析提成纯函数供单测——
// .astro 内联脚本 vitest import 不到，与 agentchat.ts 同一模式。
export interface OpenChatParams {
  provider: string; model: string; name?: string; ctx: number; maxout: number;
}

export function parseOpenChatParams(search: string): OpenChatParams | null {
  const q = new URLSearchParams(search);
  const provider = q.get('chat');
  const model = q.get('model');
  if (!provider || !model) return null;
  const num = (v: string | null) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : 0);
  return { provider, model, name: q.get('name') ?? undefined, ctx: num(q.get('ctx')), maxout: num(q.get('maxout')) };
}

export interface OpenConfigParams { provider: string; model: string; name?: string }

export function parseOpenConfigParams(search: string): OpenConfigParams | null {
  const q = new URLSearchParams(search);
  const provider = q.get('configure');
  const model = q.get('model');
  if (!provider || !model) return null;
  return { provider, model, name: q.get('name') ?? undefined };
}
