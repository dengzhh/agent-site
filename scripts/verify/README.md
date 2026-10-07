# 一次性验证脚本

设计阶段探针，验证完成后删除。

## acp-probe.mjs

**验证假设**：能否用官方 ACP SDK 驱动真实 agent 完成一轮流式对话。

**前置**：`npm i @agentclientprotocol/sdk@1.7.0`（在此目录）

**用法**：
```bash
node acp-probe.mjs hermes acp
node acp-probe.mjs openclaw acp
npx -y @deepseek-ai/dsh --profile acp    # 经 npx 调用 dsh
```

**已验证结果（2026-10-07）**：hermes 完整跑通 —— `initialize → session/new → prompt →
agent_thought_chunk → PONG → usage_update → end_turn`，`TEXT: "PONG"`。

**关键实现细节（踩坑）**：
- `ndJsonStream(output, input)` —— 参数顺序：output=我们写→agent读，input=agent写→我们读
- 需要 Web Streams，用 `Readable.toWeb` / `Writable.toWeb` 转换 Node 流
- 用 `ClientSideConnection` 直连；client 须实现 `sessionUpdate` / `requestPermission`
