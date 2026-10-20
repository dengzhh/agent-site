// 我们的 transcript → pi CLI 原生会话格式（事件日志 JSONL）。纯函数，不碰文件系统——
// 写入共享目录是后面任务的事，这里只负责「造出正确的行」。
//
// 为什么需要：网关用的是 pi-agent-core **库**，它完全没有磁盘能力
// （全库无 fs 引用，sessionId 只在 payload 里透传）。网站开的 pi 会话
// 若不额外写一份，本机 `pi` 就看不到。写了这份，用户在对应目录下
//   pi --session-dir <共享目录> --session <piSessionId> "…"    同 cwd，原地续
//   pi --session-dir <共享目录> --fork    <piSessionId> "…"    跨 cwd，fork 续
// 两条路都实测可用（2026-10-20，真实 pi CLI，含跨目录 fork 后正确回忆上下文）。
//
// 只写不读：CLI 自己建的会话是同样格式，但反向喂回库的 initialState.messages
// 需要事件→消息的折叠，且会给出「能恢复」的假象——本期不做（spec 非目标）。
//
// 最小事件集经实测确认：session + session_info + message×N，每条 parentId
// 指向上一条。model_change / thinking_level_change 可以不写。
//
// 字段类型照抄本机真实会话文件（~/.pi/agent/sessions/*/*.jsonl）：
//   事件行 timestamp 是 ISO 字符串，message 载荷里的 timestamp 是 epoch 毫秒数字。
//   本机文件里没有出现过 session_info 行（都是旧的 model_change 起头），
//   其 parentId 沿用计划里实测可用文件的写法：null。
import { randomUUID } from 'node:crypto';

const SESSION_FORMAT_VERSION = 3;   // pi CLI 的 session 行固定的 version

// 12 位十六进制：链是隐式的，一次碰撞就把 parentId 指到错的人身上且毫无声息，
// 8 位的 2^32 空间撑不起这个代价，多出来的熵是免费的。
const nodeId = () => randomUUID().replace(/-/g, '').slice(0, 12);

// 出去的 JSONL 是给外部 CLI 吃的，字段错了它不会响——只会默默续出一个空会话。
// 所以宁可在这里响亮地炸：调用方传脏值是程序员 bug，不是运行时容错的对象。
// 错误消息里带上原值（截断），定位问题不用再翻调用栈。
function assertNonEmptyString(v, label) {
  if (typeof v !== 'string' || v === '') {
    throw new TypeError(`${label} must be a non-empty string, got ${String(v).slice(0, 32)}`);
  }
}

// message 是从盘上读回来的数据，形状没有保证，逐条验：
//   m 非空对象、role 是字符串、content 是数组。缺哪个字段、第几条，都写进错误。
function assertMessage(m, i) {
  const at = `messages[${i}]`;
  if (m === null || typeof m !== 'object' || Array.isArray(m)) {
    throw new TypeError(`${at} must be a message object, got ${String(m).slice(0, 32)}`);
  }
  if (typeof m.role !== 'string') {
    throw new TypeError(`${at}.role must be a string, got ${String(m.role).slice(0, 32)}`);
  }
  if (!Array.isArray(m.content)) {
    throw new TypeError(`${at}.content must be an array, got ${String(m.content).slice(0, 32)}`);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.piSessionId 本机 pi 用来 resume 的会话 id
 * @param {string} opts.cwd         必须原样传入——CLI 靠它判断是否同一个 project
 * @param {string} [opts.name]      会话显示名（pi --resume 列表里看到），空缺/空白用缺省
 * @param {Array}  [opts.messages]  我们的 transcript（role/content/timestamp[/usage/stopReason]）
 * @returns {object[]} 按顺序排列的事件行对象（调用方负责逐行 JSON.stringify）
 */
export function buildPiSessionLines({ piSessionId, cwd, name, messages = [] }) {
  assertNonEmptyString(piSessionId, 'piSessionId');
  assertNonEmptyString(cwd, 'cwd');
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array if given');
  // 名字只有「没给/空串/空白」落回缺省；给了别的类型是脏值，照头部的口径响亮地炸
  if (name !== undefined && name !== null && typeof name !== 'string') {
    throw new TypeError(`name must be a string if given, got ${String(name).slice(0, 32)}`);
  }
  const now = new Date().toISOString();

  const infoId = nodeId();
  const lines = [
    { type: 'session', version: SESSION_FORMAT_VERSION, id: piSessionId, timestamp: now, cwd },
    { type: 'session_info', id: infoId, parentId: null, timestamp: now,
      name: typeof name === 'string' && name.trim() !== '' ? name : 'AgentToolbox' },
  ];

  let parentId = infoId;
  for (const [i, m] of messages.entries()) {
    assertMessage(m, i);
    const id = nodeId();
    const inner = {
      role: m.role,
      // 浅拷贝：这是转换器不是视图，调用方在 build 之后继续改 transcript，
      // 不能反过来改写我们即将落盘的内容
      content: [...m.content],
      // 真实 CLI 文件里这个位置是 epoch 毫秒数字（事件行的才是 ISO），照抄；
      // 非 numeric 一律回退到当下——混进来的 ISO 字符串不能原样带出去
      timestamp: Number.isFinite(m.timestamp) ? m.timestamp : Date.now(),
    };
    // usage / stopReason / api / provider / model 有就带，没有就不造字段——
    // usage 形状由调用方保证（实测 CLI 读它的 totalTokens 等字段，缺了会崩）。
    for (const k of ['usage', 'stopReason', 'api', 'provider', 'model']) {
      if (m[k] !== undefined) inner[k] = k === 'usage' ? { ...m[k] } : m[k];
    }
    // 事件行统一盖 now 是刻意的：CLI 对行只要求有序，真实时刻由载荷里的
    // timestamp 承载；逐行换时刻只添噪声。
    lines.push({ type: 'message', id, parentId, timestamp: now, message: inner });
    parentId = id;
  }
  return lines;
}

/**
 * 保证每条 assistant 消息都有 usage。**只在完全缺失时补零**：
 * pi 的 calculateContextTokens 直接读 `usage.totalTokens`，usage 整个不存在就抛
 * "Cannot read properties of undefined"（实测，库与真 CLI 0.84.3 一致）；而只缺
 * totalTokens 的残缺 usage 是安全的，照抄即可——拿零去覆盖真实计数才是撒谎。
 * user 消息本来就没有 usage，不动。
 */
export function withUsage(messages) {
  return messages.map((m) => (
    m.role === 'assistant' && m.usage === undefined
      ? { ...m, usage: emptyUsage() }
      : m
  ));
}

function emptyUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** 序列化成 JSONL 文本（末尾带换行，符合 CLI 的逐行读取）；空数组就是空文件。 */
export function renderPiSession(lines) {
  return lines.map((l, i) => {
    // null/undefined 今天会序列化成字面量 "undefined" 行，对逐行解析的 CLI 是毒
    if (l === null || typeof l !== 'object') {
      throw new TypeError(`lines[${i}] must be an object, got ${String(l).slice(0, 32)}`);
    }
    return JSON.stringify(l);
  }).join('\n') + (lines.length ? '\n' : '');
}
