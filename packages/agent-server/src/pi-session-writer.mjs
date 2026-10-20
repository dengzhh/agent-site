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

/** 生成一个 8 位短 id：parentId 链上的节点标识（CLI 只用它串链，不要求是 UUID）。 */
const nodeId = () => randomUUID().replace(/-/g, '').slice(0, 8);

// 出去的 JSONL 是给外部 CLI 吃的，字段错了它不会响——只会默默续出一个空会话。
// 所以宁可在这里响亮地炸：调用方传脏值是程序员 bug，不是运行时容错的对象。
function assertNonEmptyString(v, label) {
  if (typeof v !== 'string' || v === '') {
    throw new TypeError(`${label} must be a non-empty string`);
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
  const now = new Date().toISOString();

  const infoId = nodeId();
  const lines = [
    { type: 'session', version: SESSION_FORMAT_VERSION, id: piSessionId, timestamp: now, cwd },
    // name 先 trim 再判断：空白串和没给是一回事，都落回缺省名
    { type: 'session_info', id: infoId, parentId: null, timestamp: now,
      name: typeof name === 'string' && name.trim() !== '' ? name : 'AgentToolbox' },
  ];

  let parentId = infoId;
  for (const m of messages) {
    const id = nodeId();
    const inner = {
      role: m.role,
      content: m.content,
      // 真实 CLI 文件里这个位置是 epoch 毫秒数字（事件行的才是 ISO），照抄
      timestamp: m.timestamp ?? Date.now(),
    };
    // usage / stopReason / api / provider / model 有就带，没有就不造字段——
    // CLI 对缺失字段有容忍路径，凭空编造反而可能让它误判回合状态。
    for (const k of ['usage', 'stopReason', 'api', 'provider', 'model']) {
      if (m[k] !== undefined) inner[k] = m[k];
    }
    lines.push({ type: 'message', id, parentId, timestamp: now, message: inner });
    parentId = id;
  }
  return lines;
}

/** 序列化成 JSONL 文本（末尾带换行，符合 CLI 的逐行读取）。 */
export function renderPiSession(lines) {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
