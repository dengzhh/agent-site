// 适配器注册表：适配器只需实现 { id, available(), run(ctx) }。
// run 返回 AsyncIterable<AgentEvent>，事件契约与 SSE 层一致
// （delta / turn_end / error / done），因此路由切换对前端透明。
//
// pick 是 async 且「可用性感知」：available() 本身就是异步探活
// （例如探测 CC 二进制是否存在），因此必须 await 后才能断言
// 「偏好序里第一个可用的适配器」；偏好序中不可用/未注册的项会被跳过，
// 全部不可用时抛错，由调用方决定降级策略。
export function createRegistry(adapters) {
  const byId = new Map(adapters.map((a) => [a.id, a]));
  return {
    async status() {
      const out = [];
      for (const a of adapters) out.push({ id: a.id, available: await a.available() });
      return out;
    },
    async pick(preferred) {
      for (const id of preferred) {
        const a = byId.get(id);
        if (a && (await a.available())) return a;
      }
      throw new Error(`no available adapter for [${preferred.join(',')}]`);
    },
    get(id) { return byId.get(id); },
  };
}
