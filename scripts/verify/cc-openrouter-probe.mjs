// 一次性验证：Claude Code 运行时经 OpenRouter 能否放行 "agentic harness" gate 模型。
// 用法：OPENROUTER_API_KEY=... node cc-openrouter-probe.mjs [model-id]
// 默认测被 gate 的模型；传第二个参数可测对照模型。
import { query } from '@anthropic-ai/claude-agent-sdk';

const model = process.argv[2] ?? 'thinkingmachines/inkling-small:free';
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('需要环境变量 OPENROUTER_API_KEY');
  process.exit(1);
}

console.log(`→ probe model: ${model}`);

const q = query({
  prompt: 'Reply with exactly: PONG',
  options: {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_API_KEY: '', // 必须显式置空，否则 CC 会回落到 Anthropic 官方鉴权
      ANTHROPIC_MODEL: model,
    },
    settingSources: [],  // 不读也不写 ~/.claude/settings.json
    allowedTools: [],    // 纯聊天，不用工具
    maxTurns: 1,
  },
});

for await (const m of q) {
  if (m.type === 'assistant') {
    for (const b of m.message.content) {
      if (b.type === 'text') console.log('TEXT:', b.text.slice(0, 200));
    }
  }
  if (m.type === 'result') {
    console.log('RESULT:', m.subtype, '| is_error:', m.is_error);
    console.log('DETAIL:', String(m.result ?? '').slice(0, 400));
  }
}
