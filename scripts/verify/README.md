# 一次性技术验证脚本

这些不是产品代码，是设计阶段用于验证关键假设的探针。验证完可以删。

## cc-openrouter-probe.mjs

**验证假设**：用「真·Claude Code 运行时」通过 OpenRouter 发请求，能否放行被
"agentic harness" gate 拦截的免费模型（如 `thinkingmachines/inkling-small:free`）？

**为什么关键**：这决定了「共享本地网关 + CC 适配器」方案是否成立。若不成立，
需要重新考虑架构。

**前提**：
- Node ≥ 18
- 安装 SDK：在此目录 `npm i @anthropic-ai/claude-agent-sdk`（会拉入约 240MB 的 CLI 二进制）
- 一个可用的 OpenRouter API key（放到环境变量，不要写进文件）

**运行**：

```bash
cd ~/AI/agent-site/scripts/verify
npm init -y && npm i @anthropic-ai/claude-agent-sdk

# 先测被 gate 的模型
OPENROUTER_API_KEY='sk-or-v1-你的key' node cc-openrouter-probe.mjs thinkingmachines/inkling-small:free

# 对照：测一个已知不被 gate 的模型，确认链路本身没问题
OPENROUTER_API_KEY='sk-or-v1-你的key' node cc-openrouter-probe.mjs qwen/qwen3.8-27b:free
```

**判读**：
- `RESULT: success` + 看到 `TEXT: PONG` → **假设成立**，CC 运行时能放行 gate 模型
- `is_error: true` 且消息含 `403` / `agentic harness` → 假设不成立，gate 不只认运行时，还需应用注册
- 其它错误（鉴权、网络）→ 先排查 key / 网络，再重跑

**重要**：脚本里的 `settingSources: []` 保证不读取也不写入你的 `~/.claude/settings.json`。
