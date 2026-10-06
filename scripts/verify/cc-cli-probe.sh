#!/bin/sh
# CLI 版验证：直接驱动系统 claude CLI 走 OpenRouter（零 SDK 依赖）。
# 用法：OPENROUTER_API_KEY=... ./cc-cli-probe.sh [model-id]
#
# 关键：必须隔离用户配置。否则 claude 会读 ~/.claude/settings.json，
# 用本机默认模型并执行用户自己的 hooks（实测会跑 SessionStart hook）。
# CLAUDE_CONFIG_DIR 指向空目录，等价于 SDK 的 settingSources: []。
set -eu

MODEL="${1:-thinkingmachines/inkling-small:free}"
ISOLATED_DIR="${TMPDIR:-/tmp}/cc-probe-config"
rm -rf "$ISOLATED_DIR" && mkdir -p "$ISOLATED_DIR"

echo "→ model: $MODEL"
echo "→ isolated config dir: $ISOLATED_DIR"

CLAUDE_CONFIG_DIR="$ISOLATED_DIR" \
ANTHROPIC_BASE_URL="https://openrouter.ai/api" \
ANTHROPIC_AUTH_TOKEN="${OPENROUTER_API_KEY:?need OPENROUTER_API_KEY}" \
ANTHROPIC_API_KEY="" \
ANTHROPIC_MODEL="$MODEL" \
claude -p "Reply with exactly: PONG" \
  --output-format=stream-json --include-partial-messages --verbose \
  --max-turns 1 2>&1 \
  | grep -o '"text":"[^"]*"' | head -5

echo "--- 若上面出现 PONG 即为成功 ---"
