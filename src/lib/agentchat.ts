// AgentToolbox 本地智能体桥客户端：SSE 解析为纯函数可测；网络函数薄封装。
export const AGENT_URL = 'http://127.0.0.1:31415';

/** ACP 的 usage_update 转换结果（pi/cc 无此事件时 usage 为缺省）。 */
export interface UsageInfo { used?: number; size?: number; cost?: number }

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'usage'; usage: UsageInfo | null }
  | { type: 'activity'; title: string }
  | { type: 'turn_end'; stopReason: string | null }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface SessionRequest {
  provider: string;
  model: string;
  baseUrl?: string | null;
  /** Anthropic 兼容端点（cc 适配器用；如 openrouter 的 https://openrouter.ai/api） */
  anthropicApi?: string | null;
  apiKey?: string | null;
  envKey?: string | null;
  name?: string | null;
  contextWindow?: number;
  maxOutput?: number;
  /** 网关适配器偏好序（首个可用者胜出）；缺省时网关按 ['pi'] 处理。 */
  agents?: string[] | null;
  /** 显式指定 agent（如 'pi' / 'cc' / 'acp:hermes'）；指定后忽略 agents 偏好序。 */
  agent?: string | null;
  /** 会话工作目录；网关校验存在且是目录，否则 400。null = 用网关进程 cwd。 */
  cwd?: string | null;
  /** 工具级别：none=纯对话（默认）| read=只读工具（需 cwd，否则网关不挂工具）。 */
  toolTier?: 'none' | 'read';
}

/** 把 SSE 字节流按 \n\n 分块；返回已解析事件与未完成的尾部（下次拼接）。 */
export function parseSSEChunk(buffer: string): { events: ChatEvent[]; rest: string } {
  const events: ChatEvent[] = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('');
    if (!data) continue; // 注释心跳等
    try { events.push(JSON.parse(data) as ChatEvent); } catch { /* 跳过坏帧 */ }
  }
  return { events, rest };
}

export const keyFor = (provider: string) => `atbx:key:${provider}`;

export const keyStorage = {
  get(provider: string): string | null {
    try { return localStorage.getItem(keyFor(provider)); } catch { return null; }
  },
  set(provider: string, key: string): void {
    try { localStorage.setItem(keyFor(provider), key); } catch { /* 隐身模式等 */ }
  },
};

/** 网关已注册适配器及其探活结果（/health 的 agents 字段）。 */
export interface AgentStatus { id: string; name?: string; available: boolean }

export interface HealthInfo {
  ok: boolean;
  version: string;
  grantedDirs: string[];
  agents: AgentStatus[];
}

export async function probeHealth(baseUrl = AGENT_URL, signal?: AbortSignal): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal });
    if (!res.ok) return null;
    return (await res.json()) as HealthInfo;
  } catch { return null; }
}

export async function createSession(body: SessionRequest, baseUrl = AGENT_URL): Promise<string> {
  const res = await fetch(`${baseUrl}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`session create failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { sessionId: string };
  return data.sessionId;
}

/** 发一条消息并流式回调事件；返回时流已结束。signal 中止时 fetch 抛 AbortError。 */
export async function streamMessage(
  sessionId: string,
  text: string,
  onEvent: (ev: ChatEvent) => void,
  signal?: AbortSignal,
  baseUrl = AGENT_URL,
): Promise<void> {
  const res = await fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSSEChunk(buffer);
      buffer = rest;
      events.forEach(onEvent);
    }
  } finally {
    // onEvent 抛错时也要释放流，否则连接挂到 GC
    reader.cancel().catch(() => {});
  }
}

export async function abortSession(sessionId: string, baseUrl = AGENT_URL): Promise<void> {
  await fetch(`${baseUrl}/sessions/${sessionId}/abort`, { method: 'POST' }).catch(() => {});
}

/** OpenRouter 账号额度（经网关代理查询，key 不进 URL/日志）。查询失败返回 null。 */
export interface OpenRouterQuota {
  usage: number | null;
  limit: number | null;
  isFreeTier: boolean | null;
  rateLimit: unknown;
}

export async function fetchOpenRouterQuota(apiKey: string, baseUrl = AGENT_URL): Promise<OpenRouterQuota | null> {
  try {
    const res = await fetch(`${baseUrl}/quota/openrouter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    if (!res.ok) return null;
    return (await res.json()) as OpenRouterQuota;
  } catch { return null; }
}
