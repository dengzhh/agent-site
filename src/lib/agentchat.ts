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
  | { type: 'permission_request'; reqId: string; action: string; summary: string }
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
  /** 工具级别：none=纯对话（默认）| read=只读工具（需 cwd）| full=读+写/执行（需 cwd，动作逐个确认）。 */
  toolTier?: 'none' | 'read' | 'full';
  /** 恢复某条历史：传该记录的持久 id；不传/undefined = 新建。 */
  persistId?: string | null;
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

/** POST /sessions 的响应体：网关建会话后回显落库参数（cwd/toolTier 见 server.mjs）。 */
export interface SessionResponse {
  sessionId: string;
  adapter: string;
  provider: string;
  model: string;
  cwd: string | null;
  toolTier: 'none' | 'read' | 'full';
  /** true = 命中 persistId 恢复了已有会话；历史消息见 messages。 */
  resumed?: boolean;
  /** 恢复时网关一并回的历史消息（Task 6 的 3c）。 */
  messages?: { role: string; content: unknown }[];
}

export async function createSession(body: SessionRequest, baseUrl = AGENT_URL): Promise<SessionResponse> {
  const res = await fetch(`${baseUrl}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`session create failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as SessionResponse;
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

/** 权限卡应答。404 = 请求已超时/已收敛/回合已取消（网关按不存在处理），一律 false 不抛错。 */
export async function answerPermission(
  sessionId: string,
  reqId: string,
  allow: boolean,
  baseUrl = AGENT_URL,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/sessions/${sessionId}/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reqId, decision: allow ? 'allow' : 'deny' }),
    });
    return res.ok;
  } catch { return false; }
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

/** 历史列表的一条记录（网关只回元数据，不回 messages）。 */
export interface SessionSummary {
  id: string;
  adapter: string;
  agent: string;
  provider: string;
  model: string;
  cwd: string | null;
  toolTier: 'none' | 'read' | 'full';
  title: string;
  createdAt: number;
  lastUsed: number;
  /** pi 专属：本机 `pi --fork <piSessionId>` 用它续上。 */
  piSessionId?: string | null;
  /** pi 专属：镜像文件所在目录（网关的 ATBX_PI_SESSION_DIR）。删掉记录前
   *  它是空的；Task 9 只在这里有值时才给出可复制的命令。 */
  piSessionDir?: string | null;
  /** cc 专属：本机 `claude --resume <ccSessionId>` 用它续上。 */
  ccSessionId?: string | null;
}

export interface SessionListResponse { sessions: SessionSummary[] }

/** 列某配置下的历史。筛选四维与网关一致。 */
export async function listSessions(
  filter: { agent?: string; cwd?: string; provider?: string; model?: string },
  baseUrl = AGENT_URL,
): Promise<SessionSummary[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v) qs.set(k, v);
  const res = await fetch(`${baseUrl}/sessions?${qs}`, { headers: { 'content-type': 'application/json' } });
  if (!res.ok) return [];
  return ((await res.json()) as SessionListResponse).sessions ?? [];
}

export async function deleteSession(persistId: string, baseUrl = AGENT_URL): Promise<void> {
  await fetch(`${baseUrl}/sessions/${persistId}`, { method: 'DELETE' }).catch(() => {});
}

/** 按当前筛选范围清空。返回删掉的条数。 */
export async function clearSessions(
  filter: { agent?: string; cwd?: string; provider?: string; model?: string },
  baseUrl = AGENT_URL,
): Promise<number> {
  try {
    const res = await fetch(`${baseUrl}/sessions/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(filter),
    });
    if (!res.ok) return 0;
    return ((await res.json()) as { cleared: number }).cleared ?? 0;
  } catch { return 0; }
}

// 单引号包裹 + 把内部的 ' 转义成 '\''：POSIX sh 通用。
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 本机续接命令：把「统一管理」落到用户手里的那一行。
 * pi 需要 --session-dir（共享目录扁平存放，CLI 默认按 cwd 分子目录）；
 * cc 用 --resume，跨目录时 CLI 自己会问要不要 fork。
 */
export function localResumeCommand(s: SessionSummary): string | null {
  if (s.agent === 'pi' && s.piSessionId && s.piSessionDir) {
    // 目录必须是镜像实际所在的 <piSessionDir>：指向 ~/.pi/agent/sessions 这种
    // 「默认目录的父目录」时，listSessionsFromDir 只扫描这一层，而 CLI 自己的
    // 会话在 <父>/--<cwdSlug>--/ 子目录里，只会得到 "No session found matching"。
    // 命令里按 shell 规则加引号（路径可能含空格）。
    const dir = shellQuote(s.piSessionDir);
    const id = shellQuote(s.piSessionId);
    // 用 --fork 而不是 --session：用户几乎总在**别的目录**里粘贴这条命令，
    // 跨 cwd 时 --session 会停在 "Fork this session into current directory?
    // [y/N]" 等输入（实测 0.84.3，非交互下直接静默退出）；--fork 直接续上。
    return `pi --session-dir ${dir} --fork ${id}`;
  }
  if ((s.agent === 'cc' || s.adapter === 'cc') && s.ccSessionId) {
    return `claude --resume ${s.ccSessionId}`;
  }
  return null; // acp 等：没有互通路径，UI 据此不显示复制按钮
}
