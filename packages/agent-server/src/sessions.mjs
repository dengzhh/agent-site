// 内存会话：Map 插入序即 LRU 序；get/set 触发 TTL 清扫。重启即清空，key 不落盘。
export class SessionStore {
  constructor(capacity = 16, ttlMs = 30 * 60_000) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError(`capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }
  #sweep() {
    const now = Date.now();
    for (const [id, s] of this.map) {
      if (now - s.lastUsed > this.ttlMs) this.#drop(id);
    }
  }
  // 逐出统一走这里：给会话一次自清理机会（如拒绝挂起的权限审批），再移出 Map
  #drop(id) {
    const s = this.map.get(id);
    if (!s) return;
    this.map.delete(id);
    s.dispose?.();
  }
  get(id) {
    this.#sweep();
    const s = this.map.get(id);
    if (!s) return undefined;
    this.map.delete(id);
    s.lastUsed = Date.now();
    this.map.set(id, s);
    return s;
  }
  peek(id) { return this.map.get(id); }        // 不 touch（测试/内部用）
  /**
   * 主动让出一个会话的占用（标签页作废/换模型/关抽屉）。与逐出同一条路径
   * （#drop：自清理 + 移出 Map），但不删除任何持久状态——记录、cc 的 config
   * dir、pi 的 messages 全留在盘上，下一个 persistId 请求照样能恢复它。
   * @returns {boolean} 是否真的让出了一个活跃会话（幂等：没在占用也返回 false，
   *   不报错——调用方在每条作废路径上都会发，不该为「已经不活跃了」处理失败）
   */
  release(id) {
    if (!this.map.has(id)) return false;
    this.#drop(id);
    return true;
  }
  set(session) {
    this.#sweep();
    // 缺 lastUsed 会让 NaN 比较永不过期（永生会话）；0 则立即被清扫。由 store 兜底盖章。
    if (!session.lastUsed) session.lastUsed = Date.now();
    this.map.delete(session.id);
    this.map.set(session.id, session);
    while (this.map.size > this.capacity) {
      this.#drop(this.map.keys().next().value);
    }
  }
  get size() { return this.map.size; }
}
