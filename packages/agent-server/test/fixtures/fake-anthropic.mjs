// 最小 Anthropic /v1/messages 假上游：只为「不依赖真实 API 跑通 cc 适配器的
// 多 turn 用例」。收到请求就回一条固定 SSE 文本流，请求体追加写入
// FAKE_ANTHROPIC_LOG（便于断言第 2 轮是否带上了第 1 轮的上下文）。
// 端口写入 FAKE_ANTHROPIC_PORT_FILE，调用方读它拿 base url。
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const PORT_FILE = process.env.FAKE_ANTHROPIC_PORT_FILE;
const LOG_FILE = process.env.FAKE_ANTHROPIC_LOG;
const TEXT = process.env.FAKE_ANTHROPIC_TEXT ?? 'PONG';

const frames = [
  { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', content: [], model: 'fake-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TEXT } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
];

const server = http.createServer((req, res) => {
  // CLI 会带查询串（/v1/messages?beta=true）打这个端点，故用包含匹配而非结尾匹配。
  if (req.method !== 'POST' || !req.url?.includes('/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"unexpected path"}');
    return;
  }
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > 4_000_000) req.destroy();
    else chunks.push(c);
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (LOG_FILE) appendFileSync(LOG_FILE, `${body}\n`);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const f of frames) res.write(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`);
    res.end();
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  if (PORT_FILE) appendFileSync(PORT_FILE, `${port}\n`);
  // 不 unref：假上游必须自己撑住事件循环，否则父进程一退它就跟着消失。
  // 父进程负责 SIGKILL 整个进程组（spawn 时 detached: true）。
});
