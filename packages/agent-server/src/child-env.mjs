// 子进程环境净化：剥掉宿主 Claude Code 会话的运行态变量。
//
// 网关常被从桌面快捷方式、编辑器集成或另一个 Claude Code 会话里拉起，此时
// process.env 里带着宿主会话的 id、messaging socket/token、entrypoint 以及
// deferred tool loading 开关。这些只对「宿主会话内的子进程」有意义，对网关
// spawn 的独立 agent 进程全是污染：
//  - ENABLE_TOOL_SEARCH=true 让 claude CLI 延后加载工具，首轮 tools[] 缺项；
//    OpenRouter 等非 Anthropic 兼容端点直接 400（Deferred custom tools ...）。
//  - CLAUDE_CODE_SESSION_ID / MESSAGING_SOCKET / MESSAGING_TOKEN 让子进程误以为
//    自己属于宿主会话，可能连上宿主的 messaging socket。
// 与 CLAUDE_CONFIG_DIR 隔离同一思路：网关控制的进程不继承宿主会话运行态。
//
// 刻意保留的：PATH/HOME 等系统变量；ANTHROPIC_* 等 provider 变量（由各适配器
// 按会话显式覆写）；CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC、SUBAGENT_MODEL 等
// 无害的用户配置（剥掉会静默改变用户意图）。
//
// 新增会话作用域变量时请补进下表。
export const HOST_SESSION_ENV = [
  'ENABLE_TOOL_SEARCH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_PROMPT_SUGGESTION',
];

// 返回剥掉宿主会话变量的副本；不修改入参（调用方可能复用）。
export function sanitizeChildEnv(baseEnv) {
  const out = { ...baseEnv };
  for (const key of HOST_SESSION_ENV) delete out[key];
  return out;
}
