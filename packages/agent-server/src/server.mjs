// 只监听 127.0.0.1 的 agent 桥：health / sessions / messages(SSE) / abort。
// 会话的推理不再内联在本文件：由适配器注册表挑一个适配器（pi / cc）承接，
// server 只负责 HTTP/SSE/CORS 与会话状态（键不落盘）。
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolveModel } from './providers.mjs';
import { createRegistry } from './adapters/registry.mjs';
import { createPiAdapter } from './adapters/pi.mjs';
import { createCcAdapter } from './adapters/cc.mjs';
import { createAcpAdapter } from './adapters/acp.mjs';
import { listAgentIds, getAgentDef } from './adapters/acp-agents.mjs';
import { loadConfig } from './config.mjs';
import { SessionStore } from './sessions.mjs';
import { encodeSSE } from './sse.mjs';
import { VERSION } from './version.mjs';
import { log, preview } from './log.mjs';

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
export async function startServer({ port = 0, hostname = '127.0.0.1', allowedOrigins = DEFAULT_ORIGINS, resolve = resolveModel, models, registry, acpProbe }) {
  // ACP 适配器承接 hermes/openclaw/opencode/codex/dsh 五个子 agent。
  // acpProbe 可注入：测试用它拿到确定性的可用性，避免 shell 出去跑 `which`。
  const acpAdapter = createAcpAdapter(acpProbe ? { probe: acpProbe } : {});
  const reg = registry ?? createRegistry([
    createPiAdapter({ models, resolve }),
    createCcAdapter(),
    acpAdapter,
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
    if (cors === null) {
      log('http', `BLOCKED ${req.method} ${url.pathname} origin=${origin}`);
      res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"origin not allowed"}'); return;
    }
    // 每个请求一行：方法 + 路径 + 来源（/health 探测是网站轮询的信号，保留）
    log('http', `${req.method} ${url.pathname}${origin ? ` origin=${origin}` : ''}`);
    const json = (code, obj) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors }).end(JSON.stringify(obj));

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        // 适配器级状态（pi/cc/acp）+ 每个 ACP 子 agent 一条（acp:<id>），
        // 前端据此只列出本机真正可用的 agent。
        const status = await reg.status();
        const acpEntries = [];
        for (const id of listAgentIds()) {
          acpEntries.push({
            id: `acp:${id}`,
            name: getAgentDef(id).name,
            available: await acpAdapter.availableFor(id),
          });
        }
        return json(200, {
          ok: true,
          version: VERSION,
          agents: [...status, ...acpEntries],
          grantedDirs: loadConfig().grantedDirs,
        });
      }

      if (req.method === 'POST' && url.pathname === '/sessions') {
        const body = await readJson(req);
        if (body == null || typeof body !== 'object') return json(400, { error: 'JSON object body required' });
        // 选适配器。优先级：显式 agent > agents 偏好序 > 默认 ['pi']。
        //  ① body.agent = 'acp:<id>' → 指定某个 ACP 子 agent；
        //  ② body.agent = 'pi'/'cc' → 用户在抽屉下拉里显式选择，必须尊重——
        //     否则会被模型行的数据标注（如 openrouter 的 ['cc','pi']）覆盖掉用户选择；
        //  ③ 缺省 → 按数据标注的偏好序探活。
        let adapter; let acpAgentId = null;
        if (typeof body.agent === 'string' && body.agent.startsWith('acp:')) {
          acpAgentId = body.agent.slice(4);
          adapter = acpAdapter;
        } else if (typeof body.agent === 'string' && body.agent) {
          adapter = await reg.pick([body.agent]);
        } else {
          adapter = await reg.pick(body.agents ?? ['pi']);
        }
        const id = randomUUID();
        // 不再预建 Agent：适配器在 /messages 时才构造运行时，会话只存运行所需输入。
        sessions.set({
          id,
          adapter,
          acpAgentId,
          request: body,
          apiKey: body.apiKey ?? null,
          grantedDirs: loadConfig().grantedDirs,
          ccSessionId: null,
          lastUsed: Date.now(),
          streaming: false,
        });
        log('session', `+ ${id.slice(0, 8)} via ${acpAgentId ? `acp:${acpAgentId}` : adapter.id}` +
          ` provider=${body.provider} model=${body.model}`);
        return json(200, { sessionId: id, adapter: adapter.id, provider: body.provider, model: body.model });
      }

      const msgMatch = req.method === 'POST' && url.pathname.match(/^\/sessions\/([0-9a-f-]+)\/messages$/);
      if (msgMatch) {
        const session = sessions.get(msgMatch[1]);
        if (!session) { log('turn', `${msgMatch[1].slice(0, 8)} ✗ unknown session`); return json(404, { error: 'unknown session' }); }
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
        const short = session.id.slice(0, 8);
        const who = session.acpAgentId ? `acp:${session.acpAgentId}` : session.adapter.id;
        log('turn', `${short} ← "${preview(text)}" (via ${who})`);
        // 事件统计：逐条打 delta 会刷屏，聚合出「正文/思维链字符数 + 事件数」更有用
        let deltaChars = 0, thinkChars = 0, toolCalls = 0;
        let clientGone = false;
        res.on('close', () => {
          if (session.streaming) {
            clientGone = true;
            log('turn', `${short} ✂ client disconnected — aborting`);
          }
          ac.abort();
        });
        try {
          for await (const ev of session.adapter.run({
            // sessionId 是 pi 适配器跨轮缓存 Agent（= 多轮上下文）的键；前端每轮只发
            // { text }，历史只能由服务端持有。
            sessionId: session.id,
            agentId: session.acpAgentId,   // acp 适配器用；其它适配器忽略
            messages: [{ role: 'user', content: text }],
            request: session.request,
            apiKey: session.apiKey,
            signal: ac.signal,
            model: session.request.model,
            baseUrl: session.request.baseUrl,
            anthropicApi: session.request.anthropicApi,
            cwd,
            allowedTools,
            resumeSessionId: session.ccSessionId,
          })) {
            if (ev.sessionId) session.ccSessionId = ev.sessionId; // cc 续会话
            if (ev.type === 'delta') { deltaChars += ev.text?.length ?? 0; send('delta', { text: ev.text }); }
            else if (ev.type === 'thinking') { thinkChars += ev.text?.length ?? 0; send('thinking', { text: ev.text }); }
            else if (ev.type === 'usage') send('usage', { usage: ev.usage });
            // activity（工具调用提示）目前前端不消费，但透传成本为零且保留信息；
            // 未识别的 SSE 类型前端会安全忽略。
            else if (ev.type === 'activity') { toolCalls += 1; send('activity', { title: ev.title }); }
            else if (ev.type === 'turn_end') send('turn_end', { stopReason: ev.stopReason ?? null });
            else if (ev.type === 'error') send('error', { message: ev.message });
          }
          log('turn', `${short} ✓ end reply=${deltaChars}ch thinking=${thinkChars}ch tools=${toolCalls}`);
        } catch (err) {
          log('turn', `${short} ✗ error: ${preview(err?.message ?? err, 120)}`);
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
        log('turn', `${abortMatch[1].slice(0, 8)} ⏹ abort requested`);
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
