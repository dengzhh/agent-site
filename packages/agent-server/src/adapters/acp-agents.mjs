// ACP agent 定义表：每个 agent 的启动命令 + 配置隔离环境变量。
// 隔离变量名来自各 agent 的官方文档；实现时须逐个实测确认（见 spec 风险节）。
// 未实测通过的 agent 不应出现在 UI —— available() 探测失败即自动隐藏。
export const ACP_AGENTS = {
  hermes: {
    name: 'Hermes',
    cmd: 'hermes',
    args: ['acp'],
    isolateEnv: (dir) => ({ HERMES_HOME: dir }),
  },
  openclaw: {
    name: 'OpenClaw',
    cmd: 'openclaw',
    args: ['acp'],
    isolateEnv: (dir) => ({ OPENCLAW_HOME: dir }),
  },
  opencode: {
    name: 'OpenCode',
    cmd: 'opencode',
    args: ['acp'],
    isolateEnv: (dir) => ({ OPENCODE_CONFIG_DIR: dir, OPENCODE_DISABLE_CLAUDE_CODE: '1' }),
  },
  codex: {
    // Zed 官方适配器：把 Codex 包装成 ACP 服务端，无需全局安装 codex
    name: 'Codex',
    cmd: 'npx',
    args: ['-y', '@zed-industries/codex-acp'],
    isolateEnv: (dir) => ({ CODEX_HOME: dir }),
  },
  dsh: {
    // DeepSeek Harness 的一等公民 ACP profile
    name: 'DeepSeek Harness',
    cmd: 'npx',
    args: ['-y', '@deepseek-ai/dsh', '--profile', 'acp'],
    isolateEnv: (dir) => ({ DSH_HOME: dir }),
  },
};

export function getAgentDef(id) {
  return ACP_AGENTS[id];
}

export function listAgentIds() {
  return Object.keys(ACP_AGENTS);
}
