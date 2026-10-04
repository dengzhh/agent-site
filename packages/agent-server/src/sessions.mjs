// 内存会话：Map 插入序即 LRU 序；get/set 触发 TTL 清扫。重启即清空，key 不落盘。
export class SessionStore {
  constructor(capacity = 16, ttlMs = 30 * 60_000) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }
  #sweep() {
    const now = Date.now();
    for (const [id, s] of this.map) {
      if (now - s.lastUsed > this.ttlMs) this.map.delete(id);
    }
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
  set(session) {
    this.#sweep();
    this.map.delete(session.id);
    this.map.set(session.id, session);
    while (this.map.size > this.capacity) {
      this.map.delete(this.map.keys().next().value);
    }
  }
  get size() { return this.map.size; }
}
