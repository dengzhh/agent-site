// 会话 transcript 的磁盘存储。与 SessionStore（内存、活跃会话）分工：
// 内存那份管「正在跑的回合、挂起的审批、SSE 连接」，磁盘这份管
// 「跨重启/跨逐出的历史」。会话被内存 LRU 逐出时内容留在这里，不删。
//
// 安全取向（spec Security 节）：transcript 含 full tier 的工具输出、读过的
// 文件、截图，故文件 0600 / 目录 0700。apiKey 永不进这里——那由调用方保证
// 只走请求体，本模块也不提供任何存取 key 的入口。
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync,
  renameSync, rmSync, chmodSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';

const FORMAT_VERSION = 1;

export class TranscriptStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir          存储目录（测试传临时目录）
   * @param {number} [opts.ttlMs]      TTL；缺省 7 天
   */
  constructor({ dir, ttlMs = 7 * 24 * 60 * 60 * 1000 }) {
    if (!dir) throw new TypeError('TranscriptStore requires a dir');
    this.dir = dir;
    this.ttlMs = ttlMs;
    mkdirSync(dir, { recursive: true });
    // 目录可能已存在且权限偏松（例如用户预先建的），这里统一收紧
    try { chmodSync(dir, 0o700); } catch { /* 非 posix：忽略 */ }
  }

  #path(id) { return join(this.dir, `${id}.json`); }

  // 原子写：先写同目录临时文件再 rename。进程在写一半时被杀，不会留下半截 JSON。
  #writeFile(id, obj) {
    const final = this.#path(id);
    const tmp = `${final}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    try { chmodSync(tmp, 0o600); } catch { /* 非 posix：忽略 */ }
    renameSync(tmp, final);   // 同文件系统内原子替换
  }

  /**
   * 写入或更新一条记录。createdAt 保持首次值，lastUsed 每次刷新。
   * @param {object} rec 至少含 id；其余字段见 spec 的单文件格式
   */
  save(rec) {
    if (!rec?.id) throw new TypeError('record.id required');
    const prev = this.#read(this.#path(rec.id));
    const now = Date.now();
    const merged = {
      v: FORMAT_VERSION,
      ...rec,
      createdAt: prev?.createdAt ?? rec.createdAt ?? now,
      // 调用方显式给了 lastUsed 就尊重它（导入/迁移既有记录、测试造时间线）；
      // 没给才盖当前时间。永远用 now 会把导入的历史全部「刷新」成当下。
      lastUsed: rec.lastUsed ?? now,
    };
    this.#writeFile(rec.id, merged);
    return merged;
  }

  #read(path) {
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch { return null; }
    let obj;
    try { obj = JSON.parse(raw); } catch {
      this.#quarantine(path);
      return null;
    }
    // 版本不符一律当损坏：绝不猜测未来格式的形状（spec 边界情况节）
    if (obj?.v !== FORMAT_VERSION || typeof obj.id !== 'string') {
      this.#quarantine(path);
      return null;
    }
    return obj;
  }

  #quarantine(path) {
    try { renameSync(path, `${path.replace(/\.json$/, '')}.corrupt.json`); } catch { /* 已移动/已删 */ }
  }

  get(id) {
    if (!id) return null;
    return this.#read(this.#path(id));
  }

  /**
   * 列某配置下的历史。messages 一律剥掉——列表只该看到元数据，
   * 否则几百条消息的会话会把列表响应撑爆。
   * @param {object} filter {agent, cwd, provider, model} 全部可选，给的都需匹配
   * @returns {object[]} 按 lastUsed 降序
   */
  list(filter = {}) {
    let names;
    try { names = readdirSync(this.dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const rec = this.#read(join(this.dir, name));
      if (!rec) continue;
      if (filter.agent != null && rec.agent !== filter.agent) continue;
      if (filter.cwd != null && rec.cwd !== filter.cwd) continue;
      if (filter.provider != null && rec.provider !== filter.provider) continue;
      if (filter.model != null && rec.model !== filter.model) continue;
      const { messages, ...meta } = rec;
      out.push(meta);
    }
    return out.sort((a, b) => b.lastUsed - a.lastUsed);
  }

  /**
   * 删一条历史：json + cc 的持久 config dir（若有）。幂等。
   * @returns {boolean} 是否真的删掉过 json（用于区分「删了」与「本来就没有」）
   */
  remove(id) {
    if (!id) return false;
    const path = this.#path(id);
    // rmSync 的 force 只是不抛异常，不等于文件存在；返回值必须看存在性
    const existed = existsSync(path);
    rmSync(path, { force: true });
    // cc 会话带一个持久 config dir（--resume 依赖它），删除时要连目录一起收
    rmSync(join(this.dir, `${id}.cc`), { recursive: true, force: true });
    return existed;
  }

  /** 按筛选范围清空（不提供全局清空——那是 CLI 的权力，spec 非目标）。 */
  clear(filter = {}) {
    const ids = this.list(filter).map((r) => r.id);
    for (const id of ids) this.remove(id);
    return ids.length;
  }

  /**
   * TTL 清扫：删掉 lastUsed 超期的记录。网关启动时调一次。
   * @param {number} [now] 可注入的当前时间（测试用）
   * @returns {string[]} 被删掉的 id
   */
  sweep(now = Date.now()) {
    const dropped = [];
    for (const rec of this.list({})) {
      if (now - rec.lastUsed > this.ttlMs) {
        this.remove(rec.id);
        dropped.push(rec.id);
      }
    }
    return dropped;
  }
}