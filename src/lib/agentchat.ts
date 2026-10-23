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
  // 状态码单独挂在 error 上：调用方要按 409 分流，不该去正则匹配消息文本。
  if (!res.ok) throw Object.assign(new Error(`session create failed: ${res.status} ${await res.text()}`), { status: res.status });
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

/**
 * 让出一个会话的占用（不删任何持久状态）。换模型卡片、换 agent、改 cwd/级别、
 * 关抽屉——前端每条作废旧会话的路径都要走它：不释放的话网关侧那条内存会话还
 * 活着，下一次带 persistId 的 POST /sessions 会命中 409「session already active」，
 * 前端只能转开新对话，历史照样不出现。
 * 网关对「本来就没在占用」也回 204，所以这里刻意不返回值、不抛错。
 */
export async function releaseSession(sessionId: string, baseUrl = AGENT_URL): Promise<void> {
  await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/release`, { method: 'POST' }).catch(() => {});
}

// 「先释放、再恢复」的闸门。让出占用与「带 persistId 的 POST /sessions」是
// **因果关系**：旧会话还占着内存时，恢复请求只会撞 409「session already
// active」。两条 fetch 同时打出去时谁先到网关并不确定（POST 先到就是那条
// 409），而前端看到的是「正在另一个标签页里使用」的假提示 + 历史不出现——
// 正是「切换模型后会话历史应该不变」要消灭的失败。
// 三条作废旧会话的路径（resetSession / openChat / 关抽屉）都是同步函数，
// 没法 await，于是把 in-flight 的 promise 寄存在这里，由建会话前的一刻等它。
// releaseSession 自己吞掉网络错，所以这个 promise 不会 reject。
let pendingRelease: Promise<void> | null = null;

/** 登记一次让出占用（不等它）。之后 awaitPendingRelease() 会等到它落地。 */
export function releaseSessionQueued(sessionId: string, baseUrl = AGENT_URL): void {
  pendingRelease = releaseSession(sessionId, baseUrl);
}

/** 等已登记的让出占用落地。幂等：没有待办的立即返回（绝不因此卡住建会话）。 */
export async function awaitPendingRelease(): Promise<void> {
  const p = pendingRelease;
  if (p) await p;
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

/**
 * OpenRouter 账号额度（经网关代理查询，key 不进 URL/日志）。查询失败返回 null。
 * 字段语义按 openrouter.ai/docs/api_reference/limits：
 *   creditsUsed / creditLimit / creditRemaining —— 支出额度，单位 credits（不是请求数）；
 *   freeRequests / freeUsed / freeRemaining —— 免费模型（:free）的每日请求数，
 *     freeRequests 由累计购买 credits 决定（<10 → 50/天，≥10 → 1000/天），
 *     **与 isFreeTier 无关**，所以不能由 isFreeTier 推断出 50。
 * 拿不到的字段一律 null，展示方需显示"未知"而非补一个默认值。
 */
export interface OpenRouterQuota {
  creditsUsed: number | null;
  creditLimit: number | null;
  creditRemaining: number | null;
  isFreeTier: boolean | null;
  freeRequests: number | null;
  freeUsed: number | null;
  freeRemaining: number | null;
}

/**
 * 额度行文案。只写上游真给的数字，拿不到的一律"未知"——不外推、不补默认数。
 * 语义（openrouter.ai/docs/api_reference/limits）：
 *   freeRequests = 免费模型（:free）每日请求上限，由累计购买 credits 决定
 *     （<10 → 50/天，≥10 → 1000/天），**与 isFreeTier 无关**，
 *     所以绝不能由 isFreeTier 推断出 50；上游不给该对象时如实说"未知"。
 *   credits 单位是 credits，**不是请求数**。每分钟限额上游不上报，故不展示。
 */
export function formatQuota(q: OpenRouterQuota): string {
  const parts: string[] = [];
  if (q.freeRequests != null) {
    parts.push(
      q.freeUsed != null
        ? `免费模型 今日 ${q.freeUsed}/${q.freeRequests} 次`
        : `免费模型 每日上限 ${q.freeRequests} 次`,
    );
  } else {
    // 上游没给 = 该账号/端点不受免费模型限额约束，或字段缺失，两者无法区分
    parts.push('免费模型限额 未知');
  }
  if (q.creditLimit != null && q.creditRemaining != null) {
    parts.push(`余额 ${q.creditRemaining}/${q.creditLimit} credits`);
  } else if (q.creditRemaining != null) {
    parts.push(`余额 ${q.creditRemaining} credits`);
  } else if (q.creditsUsed != null) {
    parts.push(`已用 ${q.creditsUsed} credits`);
  } else {
    parts.push('余额 未知');
  }
  return parts.join(' · ');
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
  /** 可缺：恢复路径不改写记录的 tier，早期记录也可能没有。 */
  toolTier?: 'none' | 'read' | 'full';
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

/** 列某配置下的历史。筛选两维（agent/cwd）与网关一致。 */
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

/** 删一条历史。返回 false 表示网关没删（409 = 会话仍活跃；也可能是网络错/404）。 */
export async function deleteSession(persistId: string, baseUrl = AGENT_URL): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(persistId)}`, { method: 'DELETE' });
    return res.ok;
  } catch { return false; }
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

/**
 * 把一条历史消息的 content 拆成渲染用的块序列。
 *
 * 恢复渲染循环此前把非 text 块画成 `[${blk.type}]`，思维链于是显示成
 * `[thinking]`。cc 的 block 是 Anthropic 标准形状（`{type:'text',text}` /
 * `{type:'thinking',thinking}`），与 pi 存进 messages 的完全一致，故这里
 * 只做分流、不做转换。
 *
 * 提成纯函数是因为 `free-models.astro` 的脚本内联在 .astro 里，vitest
 * import 不到（node 环境也没有 DOM）——与 drawer.ts / prompt.ts 同一模式。
 */
export type HistoryBlock =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'image'; text: string }
  | { kind: 'unknown'; text: string };

export function historyBlocks(content: unknown): HistoryBlock[] {
  // 字符串 content（少数模型/早期记录）：一条正文，不必假装有块结构。
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const out: HistoryBlock[] = [];
  for (const raw of content) {
    const blk = raw as { type?: unknown; text?: unknown; thinking?: unknown } | null;
    const type = blk && typeof blk === 'object' ? blk.type : undefined;
    if (type === 'thinking') out.push({ kind: 'thinking', text: String(blk!.thinking ?? '') });
    else if (type === 'text') out.push({ kind: 'text', text: String(blk!.text ?? '') });
    else if (type === 'image') out.push({ kind: 'image', text: '[图片]' });
    // 其他未知块：只报类型名，不编内容。缺 type 的（null / {}）什么都说不出，跳过。
    else if (typeof type === 'string') out.push({ kind: 'unknown', text: `[${type}]` });
  }
  return out;
}

/**
 * 历史列表行的模型小标。记录里本来就有 model 字段（曾是筛选键，现降级为
 * 展示元数据）；拿不到就返回空串，由调用方不渲染这个 span——不猜、不显示「未知」。
 */
export function sessionModelLabel(s: { model?: unknown }): string {
  const m = (s as { model?: unknown }).model;
  return typeof m === 'string' ? m : '';
}
