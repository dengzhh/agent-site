#!/bin/sh
# 假 claude CLI：回放固定的 stream-json，用于适配器测试。
# FAKE_CC_MODE 控制行为：ok（默认）| error | gate
echo '{"type":"system","subtype":"init","session_id":"fake-sess-1"}'
if [ "${FAKE_CC_ECHO_CONFIG:-}" = "1" ]; then
  echo "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"CFG=${CLAUDE_CONFIG_DIR}\"}}}"
  echo '{"type":"result","subtype":"success","session_id":"fake-sess-1","is_error":false,"result":"CFG"}'
  exit 0
fi
# 回显继承到的宿主会话变量（空值也回显，便于断言「已剥离」）
if [ "${FAKE_CC_ECHO_ENV:-}" = "1" ]; then
  echo "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"TS=${ENABLE_TOOL_SEARCH-unset}|SID=${CLAUDE_CODE_SESSION_ID-unset}|SOCK=${CLAUDE_CODE_MESSAGING_SOCKET-unset}|CTX=${FAKE_CC_CONTROL-unset}\"}}}"
  echo '{"type":"result","subtype":"success","session_id":"fake-sess-1","is_error":false,"result":"ENV"}'
  exit 0
fi
case "${FAKE_CC_MODE:-ok}" in
  error)
    echo '{"type":"result","subtype":"error_during_execution","session_id":"fake-sess-ERR","is_error":true,"result":"API Error: 500 boom"}'
    ;;
  gate)
    echo '{"type":"result","subtype":"error_during_execution","session_id":"fake-sess-1","is_error":true,"result":"403 only available on agentic harnesses"}'
    ;;
  *)
    echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"PONG"}}}'
    echo '{"type":"result","subtype":"success","session_id":"fake-sess-1","is_error":false,"result":"PONG"}'
    ;;
esac
