// 只监听 127.0.0.1 的 agent 桥：health / sessions / messages(SSE) / abort。
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Agent } from '@earendil-works/pi-agent-core';
import { resolveModel } from './providers.mjs';
import { SessionStore } from './sessions.mjs';
import { encodeSSE } from './sse.mjs';
import { VERSION } from './version.mjs';

const SYSTEM_PROMPT = 'You are a helpful assistant chatting in the AgentToolbox web app. Be concise and useful.';

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

function makeAgent(models, model, sessionId, apiKey) {
  return new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model },
    streamFn: models.streamSimple.bind(models),
    sessionId,
    getApiKey: () => apiKey,
  });
}

export async function startServer({ port = 0, hostname = '127.0.0.1', allowedOrigins = DEFAULT_ORIGINS, resolve = resolveModel, models }) {
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
    const json = (code, obj) => res.writeHead(code, { 'content-type': 'application/json', ...cors }).end(JSON.stringify(obj));

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(200, { ok: true, version: VERSION, grantedDirs: [] });
      }

      if (req.method === 'POST' && url.pathname === '/sessions') {
        const body = await readJson(req);
        const { model, providerId } = resolve(models, body);
        const id = randomUUID();
        const agent = makeAgent(models, model, id, body.apiKey ?? null);
        sessions.set({ id, agent, model, providerId, apiKey: body.apiKey ?? null, lastUsed: Date.now(), streaming: false });
        return json(200, { sessionId: id, provider: body.provider, model: body.model });
      }

      const msgMatch = req.method === 'POST' && url.pathname.match(/^\/sessions\/([0-9a-f-]+)\/messages$/);
      if (msgMatch) {
        const session = sessions.get(msgMatch[1]);
        if (!session) return json(404, { error: 'unknown session' });
        if (session.streaming) return json(409, { error: 'already streaming' });
        const { text } = await readJson(req);
        if (typeof text !== 'string' || !text.trim()) return json(400, { error: 'text required' });

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          ...cors,
        });
        const send = (type, payload) => res.write(encodeSSE(type, payload));
        session.streaming = true;
        // 客户端断开 → 中止本轮生成
        res.on('close', () => { if (session.streaming) session.agent.abort(); });
        const unsub = session.agent.subscribe((ev) => {
          if (ev.type === 'message_update' && ev.assistantMessageEvent.type === 'text_delta') {
            send('delta', { text: ev.assistantMessageEvent.delta });
          } else if (ev.type === 'turn_end') {
            send('turn_end', { stopReason: ev.message.stopReason ?? null });
          }
        });
        try {
          await session.agent.prompt(text);
        } catch (err) {
          send('error', { message: String(err?.message ?? err) });
        } finally {
          unsub();
          session.streaming = false;
          send('done', {});
          res.end();
        }
        return;
      }

      const abortMatch = req.method === 'POST' && url.pathname.match(/^\/sessions\/([0-9a-f-]+)\/abort$/);
      if (abortMatch) {
        const session = sessions.get(abortMatch[1]);
        if (!session) return json(404, { error: 'unknown session' });
        session.agent.abort();
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
