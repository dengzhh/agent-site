// 只监听 127.0.0.1 的 agent 桥：health / sessions / messages(SSE) / abort。
// 会话的推理不再内联在本文件：由适配器注册表挑一个适配器（pi / cc）承接，
// server 只负责 HTTP/SSE/CORS 与会话状态（键不落盘）。
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolveModel } from './providers.mjs';
import { createRegistry } from './adapters/registry.mjs';
import { createPiAdapter } from './adapters/pi.mjs';
import { createCcAdapter } from './adapters/cc.mjs';
import { loadConfig } from './config.mjs';
import { SessionStore } from './sessions.mjs';
import { encodeSSE } from './sse.mjs';
import { VERSION } from './version.mjs';

const DEFAULT_ORIGINS = ['https://dengzhh.github.io'];

function corsHeaders(origin, allowed) {
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

async function readJson(req, cap = 1_000_000) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > cap) throw Object.assign(new Error('body too large'), { statusCode: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // 请求体不是合法 JSON → 客户端错误，而非 500
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 });
  }
}

// SYSTEM_PROMPT / STREAM_TIMEOUT_MS / undici 长超时 dispatcher 都随 pi 适配器搬到了
// adapters/pi.mjs（单一来源），本文件不再持有副本。
export async function startServer({ port = 0, hostname = '127.0.0.1', allowedOrigins = DEFAULT_ORIGINS, resolve = resolveModel, models, registry }) {
  const reg = registry ?? createRegistry([
    createPiAdapter({ models, resolve }),
    createCcAdapter(),
  ]);
  const sessions = new SessionStore();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;

    // 预检（含 Chrome PNA：https 公网站点访问 localhost 的关键）
    if (req.method === 'OPTIONS') {
      const cors = corsHeaders(origin, allowedOrigins);
      if (!cors) { res.writeHead(403).end(); return; }
      res.writeHead(204, {
        ...cors,
        ...(req.headers['access-control-request-private-network'] === 'true'
          ? { 'access-control-allow-private-network': 'true' } : {}),
      });
      res.end();
      return;
    }

    const cors = origin === undefined ? {} : (corsHeaders(origin, allowedOrigins) ?? null);
    if (cors === null) { res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"origin not allowed"}'); return; }
    const json = (code, obj) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors }).end(JSON.stringify(obj));

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(200, {
          ok: true,
          version: VERSION,
          agents: await reg.status(),
          grantedDirs: loadConfig().grantedDirs,
        });
      }

      if (req.method === 'POST' && url.pathname === '/sessions') {
        const body = await readJson(req);
        if (body == null || typeof body !== 'object') return json(400, { error: 'JSON object body required' });
        // 选适配器（异步探活，必须 await）。body.agents 是前端给的偏好序，
        // 缺省 ['pi']；全部不可用时 pick 抛错 → 走统一错误出口（500）。
        const adapter = await reg.pick(body.agents ?? ['pi']);
        const id = randomUUID();
        // 不再预建 Agent：适配器在 /messages 时才构造运行时，会话只存运行所需输入。
        sessions.set({
          id,
          adapter,
          request: body,
          apiKey: body.apiKey ?? null,
          grantedDirs: loadConfig().grantedDirs,
          ccSessionId: null,
          lastUsed: Date.now(),
          streaming: false,
        });
        return json(200, { sessionId: id, adapter: adapter.id, provider: body.provider, model: body.model });
      }

      const msgMatch = req.method === 'POST' && url.pathname.match(/^\/sessions\/([0-9a-f-]+)\/messages$/);
      if (msgMatch) {
        const session = sessions.get(msgMatch[1]);
        if (!session) return json(404, { error: 'unknown session' });
        if (session.streaming) return json(409, { error: 'already streaming' });
        // 先同步占位再读 body：否则两个并发请求都能通过检查（TOCTOU）
        session.streaming = true;
        const { text } = await readJson(req).catch((err) => {
          session.streaming = false;
          throw err;
        });
        if (typeof text !== 'string' || !text.trim()) {
          session.streaming = false;
          return json(400, { error: 'text required' });
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          ...cors,
        });
        const send = (type, payload) => res.write(encodeSSE(type, payload));
        // 授权目录 → 只读工具 + cwd（只有 cc 适配器用得上：granted 目录是其可读范围，
        // 无授权时 allowedTools 为空 = 不给任何工具）。
        const isCc = session.adapter.id === 'cc';
        const granted = session.grantedDirs ?? [];
        const allowedTools = isCc && granted.length ? ['Read', 'Grep', 'Glob'] : [];
        const cwd = isCc ? granted[0] : undefined;
        // 每轮一个 AbortController：客户端断开 → abort()，/abort 路由也经它取消
        // （abort 幂等，重复调用无害）。cancel 钩子挂在会话上供 /abort 调用。
        const ac = new AbortController();
        session.cancel = () => ac.abort();
        res.on('close', () => ac.abort());
        try {
          for await (const ev of session.adapter.run({
            messages: [{ role: 'user', content: text }],
            request: session.request,
            apiKey: session.apiKey,
            signal: ac.signal,
            model: session.request.model,
            baseUrl: session.request.baseUrl,
            cwd,
            allowedTools,
            resumeSessionId: session.ccSessionId,
          })) {
            if (ev.sessionId) session.ccSessionId = ev.sessionId; // cc 续会话
            if (ev.type === 'delta') send('delta', { text: ev.text });
            else if (ev.type === 'turn_end') send('turn_end', { stopReason: ev.stopReason ?? null });
            else if (ev.type === 'error') send('error', { message: ev.message });
          }
        } catch (err) {
          send('error', { message: String(err?.message ?? err) });
        } finally {
          session.streaming = false;
          session.cancel = null;
          send('done', {});
          res.end();
        }
        return;
      }

      const abortMatch = req.method === 'POST' && url.pathname.match(/^\/sessions\/([0-9a-f-]+)\/abort$/);
      if (abortMatch) {
        const session = sessions.get(abortMatch[1]);
        if (!session) return json(404, { error: 'unknown session' });
        // 未在流式中的会话没有 cancel 钩子：no-op（与旧的 agent.abort() 同为幂等无害）
        session.cancel?.();
        return res.writeHead(204, cors).end();
      }

      return json(404, { error: 'not found' });
    } catch (err) {
      const code = err.statusCode ?? (err.name === 'UnsupportedError' ? 400 : 500);
      return json(code, { error: err.name === 'UnsupportedError' ? 'unsupported' : 'internal', message: String(err?.message ?? err) });
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, resolvePromise);
  });
  return {
    server,
    port: server.address().port,
    sessions,
    close: () => new Promise((r) => server.close(r)),
  };
}
