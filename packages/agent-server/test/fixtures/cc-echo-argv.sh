#!/bin/sh
# 假 CC（argv 回显）：把收到的每个 argv 元素作为 delta 回显后正常收尾，
# 供测试断言 cc 适配器按 toolTier 构造的命令行参数。（argv 值均为无引号/反斜杠的
# 简单 token，直接内插进 JSON 字符串是安全的。）
for arg in "$@"; do
  printf '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ARG=%s"}}}\n' "$arg"
done
echo '{"type":"result","subtype":"success","session_id":"fake-argv-sess","is_error":false,"result":"argv"}'
