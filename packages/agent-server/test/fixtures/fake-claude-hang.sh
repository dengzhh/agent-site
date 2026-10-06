#!/bin/sh
# 长驻夹具：产生两条事件后长时间不退出，用于测试 abort / 生命周期清理。
# 把自身 pid 写进 $FAKE_PIDFILE，测试据此探测进程是否真的被杀死。
echo $$ > "$FAKE_PIDFILE"
echo '{"type":"system","subtype":"init","session_id":"hang-sess"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"tick"}}}'
# 阻塞在 sleep 上（不主动退出），直到被 kill。长于任何合理的测试窗口。
sleep 300
