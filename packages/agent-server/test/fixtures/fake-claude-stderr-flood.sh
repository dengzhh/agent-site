#!/bin/sh
# 回归夹具：往 stderr 灌 >64KB 且**不产生任何终结行**（无 result 行）。
# 覆盖两条容易回归的路径：
#   1) 适配器必须持续排空 stderr——否则管道缓冲写满，子进程阻塞、'close' 永不触发；
#   2) 缺终结事件时适配器必须收尾并合成一个 error 事件，而不是永久挂起。
# 任一回归都会让本夹具的用例超时失败。
echo '{"type":"system","subtype":"init","session_id":"flood-sess"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"NOISE"}}}'
i=0
while [ $i -lt 2000 ]; do
  echo "stderr-filler-stderr-filler-stderr-filler-stderr-filler-stderr-filler-stderr-filler" 1>&2
  i=$((i + 1))
done
exit 7
