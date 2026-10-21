// 只监听 127.0.0.1 的 agent 桥：health / sessions / messages(SSE) / abort。
// 会话的推理不再内联在本文件：由适配器注册表挑一个适配器（pi / cc）承接，
// server 只负责 HTTP/SSE/CORS 与会话状态（键不落盘）。
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolveModel } from './providers.mjs';
import { createRegistry } from './adapters/registry.mjs';
import { createPiAdapter } from './adapters/pi.mjs';
import { createCcAdapter } from './adapters/cc.mjs';
import { createAcpAdapter } from './adapters/acp.mjs';
import { listAgentIds, getAgentDef } from './adapters/acp-agents.mjs';
import { loadConfig, sessionTtlMs, piSessionDir, sessionStoreDir } from './config.mjs';
import { TranscriptStore, SAFE_ID, ID_SOURCE } from './transcripts.mjs';
import { SessionStore } from './sessions.mjs';
import { encodeSSE } from './sse.mjs';
import { VERSION } from './version.mjs';
import { log, preview } from './log.mjs';

const DEFAULT_ORIGINS = ['https://dengzhh.github.io'];

// 带会话 id 的路由。id 的正则与 store 的 SAFE_ID 必须是同一把尺子（见
// transcripts.mjs 的 ID_SOURCE），否则一处放宽另一处仍 404。预先编译，
// 别在每个请求里 new RegExp。
const SESSION_ROUTE = Object.fromEntries(
  ['', '/messages', '/permission', '/abort'].map((tail) => [tail, new RegExp(`^/sessions/(${ID_SOURCE})${tail}$`)]),
);

// 上游字段可能缺失或非数值。统一成 number|null：UI 拿到 null 才知道"不知道"，
// 而不是把 undefined/NaN 显示成 0（那等于凭空给出一个余额）。
function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

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
// 挂起中的权限审批全部按拒绝收敛：resolve(false) + 清 Map。/abort、客户端断连、
// 会话被逐出（TTL/容量）时都必须调用，否则 approval promise 悬挂泄漏。
function denyPendingPerms(session) {
  const cbs = [...(session.pendingPerms?.values() ?? [])];
  session.pendingPerms?.clear();
  for (const cb of cbs) cb(false);
}

export async function startServer({ port = 0, hostname = '127.0.0.1', allowedOrigins = DEFAULT_ORIGINS, resolve = resolveModel, models, registry, acpProbe, approvalTimeoutMs = 120_000, transcripts = null, sessionTtlMs: ttlMs }) {
  // 磁盘 transcript：跨重启/跨逐出的历史。缺省自建（生产路径），测试注入临时目录。
  // 清扫只在我们自己建了这份 store 时做——它的语义是「启动时回收超期历史」，
  // 是**所有权**的事，不是「每建一个 server 就顺手删别人盘上的东西」。注入的
  // store 归调用方管（测试的临时目录、bin 自己的实例）。之前无条件 sweep 让
  // 每个没注入 store 的测试 fixtures 都去删开发者真实目录里超期的会话。
  const ownsStore = transcripts == null;
  const store = transcripts ?? new TranscriptStore({ dir: sessionStoreDir(), ttlMs: ttlMs ?? sessionTtlMs() });
  if (ownsStore) store.sweep();
  // ACP 适配器承接 hermes/openclaw/opencode/codex/dsh 五个子 agent。
  // acpProbe 可注入：测试用它拿到确定性的可用性，避免 shell 出去跑 `which`。
  const acpAdapter = createAcpAdapter(acpProbe ? { probe: acpProbe } : {});
  const reg = registry ?? createRegistry([
    createPiAdapter({ models, resolve, transcripts: store, piSessionDir: piSessionDir() }),
    createCcAdapter({ transcripts: store }),
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

      // OpenRouter 免费额度查询：用户 key 查自己的账号，天然安全。
      // key 走请求体，不进 URL/日志；上游失败只镜像状态码，不透传响应体。
      if (req.method === 'POST' && url.pathname === '/quota/openrouter') {
        const body = await readJson(req);
        const key = typeof body?.apiKey === 'string' ? body.apiKey : '';
        if (!key) return json(400, { error: 'apiKey required' });
        let upstream;
        try {
          upstream = await fetch('https://openrouter.ai/api/v1/key', {
            headers: { authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(10_000),
          });
        } catch (err) {
          return json(502, { error: 'upstream unreachable', message: String(err?.message ?? err) });
        }
        if (!upstream.ok) return json(upstream.status, { error: 'upstream error' });
        // 上游 200 + 坏 JSON：parse 抛错的 message 会内嵌上游响应体片段，不透出
        let data;
        try {
          data = (await upstream.json())?.data ?? {};
        } catch {
          return json(502, { error: 'upstream error', message: 'invalid JSON from upstream' });
        }
        // 字段语义按 openrouter.ai/docs/api_reference/limits：
        //   limit/limit_remaining = 支出额度（credits），不是请求数；
        //   free_model_daily_requests = 免费模型请求数（.limit 由累计购买 credits 决定：
        //     <10 → 50/天，≥10 → 1000/天，与 is_free_tier 无关）；
        //   rate_limit = 官方标注 deprecated，故不再透传。
        // 只回 UI 要用得上的字段：拿不到的保持 null，由前端显示"未知"，不猜。
        return json(200, {
          creditsUsed: numOrNull(data.usage),
          creditLimit: numOrNull(data.limit),
          creditRemaining: numOrNull(data.limit_remaining),
          isFreeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null,
          freeRequests: numOrNull(data.free_model_daily_requests?.limit),
          freeUsed: numOrNull(data.free_model_daily_requests?.used),
          freeRemaining: numOrNull(data.free_model_daily_requests?.remaining),
        });
      }

      // 历史列表：某配置下的会话，newest first，只带元数据（见 TranscriptStore.list）。
      // 筛选四维与 pi 的 cacheKey 一致：换模型不该串到别的模型的历史里。
      if (req.method === 'GET' && url.pathname === '/sessions') {
        const filter = {};
        for (const k of ['agent', 'cwd', 'provider', 'model']) {
          const v = url.searchParams.get(k);
          if (v != null && v !== '') filter[k] = v;
        }
        // piSessionDir 不是记录字段（记录里只有镜像文件的 id），是网关配置——
        // 由这里补进去：UI 的「本机续接命令」要靠它知道去哪个目录找镜像文件。
        // 记录里没有它，所以不加的话界面拿到的是空目录，给出的命令必然找不到会话。
        const dir = piSessionDir();
        const list = store.list(filter).map((r) => (
          r.adapter === 'pi' && dir ? { ...r, piSessionDir: dir } : r
        ));
        return json(200, { sessions: list });
      }

      if (req.method === 'POST' && url.pathname === '/sessions') {
        const body = await readJson(req);
        if (body == null || typeof body !== 'object') return json(400, { error: 'JSON object body required' });
        // 工作目录：可选。给出时必须存在且是目录，否则 400（用户在网页粘贴路径，笔误常见，报错要明确）。
        const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : null;
        if (cwd) {
          try {
            if (!statSync(cwd).isDirectory()) throw new Error('not a directory');
          } catch {
            return json(400, { error: 'invalid cwd', message: `working directory not accessible: ${cwd}` });
          }
        }
        // 工具级别：none=纯对话（默认，与现状一致）| read=只读工具 | full=完整（期 2）。
        // 未知值安全回落 none，绝不因误传升级权限。
        const toolTier = ['none', 'read', 'full'].includes(body.toolTier) ? body.toolTier : 'none';
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
        // persistId：带上 = 恢复既有会话（内存 session id 与它一致，前端好认）；
        // 不带 = 新建。已有活跃内存会话的同 id → 409（两个标签页不能共用一份
        // transcript，后写的会覆盖前写的）。
        const persistId = typeof body.persistId === 'string' && body.persistId.trim() ? body.persistId.trim() : null;
        // 形状在门口就拦：用它当磁盘文件名、当适配器 restore 的键，非法 id
        // 不该走到 store 抛 TypeError 再被当成 500。
        if (persistId && !SAFE_ID.test(persistId)) return json(400, { error: 'invalid persistId' });
        // 恢复已存在的记录时，归属字段（adapter/agent）以盘上为准：前端按 id
        // 恢复时未必带上原来的 agent，若照请求重写，一条 cc 会话会被标成 pi，
        // 之后按 agent 筛的列表就把它归错类。只有新建时才写归属。
        const existing = persistId ? store.get(persistId) : null;
        // 恢复材料先取出来：成功与否都要写进响应（resumed），前端据此决定要不要
        // 渲染历史。拿不到（记录没了/目录没了/agent 不支持）→ resumed:false，
        // 但 id 仍是 persistId，让前端别假装有历史。
        const material = persistId ? (adapter.restore?.(persistId) ?? null) : null;
        if (persistId && sessions.peek(persistId)) return json(409, { error: 'session already active' });
        const id = persistId ?? randomUUID();
        // 不再预建 Agent：适配器在 /messages 时才构造运行时，会话只存运行所需输入。
        const record = {
          id,
          adapter,
          acpAgentId,
          request: body,
          apiKey: body.apiKey ?? null,
          grantedDirs: loadConfig().grantedDirs,
          cwd,
          toolTier,
          ccSessionId: null,
          lastUsed: Date.now(),
          streaming: false,
          // 待批权限审批表（reqId → resolve 回调），由 run ctx 的 requestApproval 写入
          pendingPerms: new Map(),
        };
        // SessionStore 逐出（TTL/容量）时的自清理钩子：挂起的审批按拒绝收敛，
        // 并回收 cc 适配器为这个会话建的隔离配置目录（留着就是泄漏）。
        record.dispose = () => { denyPendingPerms(record); adapter.disposeSession?.(id); };
        sessions.set(record);
        // 配置字段由网关写：适配器只写自己那几个（pi 写 messages，cc 写
        // ccSessionId/configDir），筛选四维（agent/cwd/provider/model）与
        // title 只有网关知道——没有这次写入，GET /sessions 的筛选永远命中
        // 0 条，前端「会话」行会一直空着。逐字段合并，不会盖掉适配器写的。
        //
        // ⚠️ 缺省字段传 undefined（而不是 null）：save() 逐字段合并时
        // undefined =「没给」，保留盘上的旧值；null 是「显式值」，会把
        // 恢复会话（persistId）已有的 provider/cwd 抹成空。
        // ⚠️ 别用 body.name 当 title：那是**模型显示名**（前端传的是
        // `a.dataset.name`），拿它当会话标题会把列表每一行都写成同一个模型名。
        // 建会话时还没有消息，标题无从谈起——留空，由落盘那处按首条 user
        // 消息派生。UI 已有 `s.title || '(无标题)'` 的兜底。
        // ⚠️ 绝不写 apiKey —— 它不在 RECORD_FIELDS 白名单里，写了也存不进去，
        // 但别把它当参数传。
        try {
          store.save({
            id,
            ...(existing ? {} : { adapter: adapter.id, agent: acpAgentId ? `acp:${acpAgentId}` : adapter.id }),
            // 恢复既有记录时也只写「这次确实给了」的配置：toolTier 每次都在、
            // cwd 在前端是当前界面状态，全写会把记录自己的参数降级（如把
            // full 档的会话恢复成 none）。归属与配置都以盘上为准，只在请求
            // 显式给出时才更新。
            ...(existing ? {
              provider: body.provider ?? undefined, model: body.model ?? undefined,
              cwd: cwd ?? undefined,
            } : {
              provider: body.provider ?? undefined, model: body.model ?? undefined,
              cwd: cwd ?? undefined, toolTier,
            }),
          });
        } catch (err) {
          log('session', `transcript save failed for ${id.slice(0, 8)}: ${preview(err?.message ?? err, 120)}`);
        }
        log('session', `+ ${id.slice(0, 8)} via ${acpAgentId ? `acp:${acpAgentId}` : adapter.id}` +
          ` provider=${body.provider} model=${body.model} cwd=${cwd ?? '-'} tier=${toolTier}`);
        return json(200, {
          sessionId: id, adapter: adapter.id,
          resumed: Boolean(material),
          provider: body.provider, model: body.model, cwd, toolTier,
          ...(material?.messages ? { messages: material.messages } : {}),
        });
      }

      // 删单条历史（含 cc 的持久 config dir）。
      // **id 的正则必须与 store 的 SAFE_ID 对齐**：`[0-9a-f-]+` 只认小写十六进制，
      // 会把 `bye`/`dup`/`resume-me` 这类 id 挡在门外（404 而不是 204）。
      const delMatch = req.method === 'DELETE' && url.pathname.match(SESSION_ROUTE['']);
      if (delMatch) {
        // 活跃会话不能删：内存里还攥着它的运行时与审批表，下一轮会把整份历史
        // 重新写回去（等于「删了又活了」）。先让用户关掉它。
        if (sessions.peek(delMatch[1])) return json(409, { error: 'session is active' });
        store.remove(delMatch[1]);
        return res.writeHead(204, cors).end();
      }

      // 按范围清空。刻意不提供全局清空——一键抹掉所有历史的权力属于终端
      // （`agenttoolbox-agent sessions --clear`），网页不该有。
      // store.clear() 对空筛选直接抛 TypeError：路由若忘了转发筛选，
      // 宁可炸也不要默默抹掉用户全部历史。全量清空走 store.clearAll()。
      if (req.method === 'POST' && url.pathname === '/sessions/clear') {
        const body = await readJson(req);
        const filter = {};
        for (const k of ['agent', 'cwd', 'provider', 'model']) {
          if (typeof body?.[k] === 'string' && body[k]) filter[k] = body[k];
        }
        // 一个筛选条件都没认出来 = 请求体写错了（字段名拼错/类型不对）。
        // 转发空筛选会让 store.clear() 抛 TypeError（500），而把非法筛选悄悄
        // 丢掉再清全部更糟——按「请求有问题」明确拒掉。
        if (!Object.keys(filter).length) return json(400, { error: 'at least one of agent/cwd/provider/model is required' });
        // 与 DELETE 的 409 同一原则：活跃会话的记录不删（内存里还攥着运行时，
        // 下一轮会把整份历史重新写回去）。跳过它们，返回的 cleared 只数真删的。
        const cleared = store.clear(filter, { skipActive: (id) => sessions.peek(id) });
        return json(200, { cleared });
      }

      const msgMatch = req.method === 'POST' && url.pathname.match(SESSION_ROUTE['/messages']);
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
        // 工具分级：none=不给工具；read=只读三件套；full=完整工具集（含写/执行）。
        // 这里只管 cc 的 --allowedTools（read 给只读三件套，none/full 不给 cc 工具）；
        // pi 的分级在 pi.mjs 里按 toolTier 挂 readOnlyTools/fullTools。
        const isCc = session.adapter.id === 'cc';
        const allowedTools = isCc && session.toolTier === 'read' ? ['Read', 'Grep', 'Glob'] : [];
        // cwd 语义：cc 用授权目录（CLI 的工作目录）；pi/其他用会话 cwd（工具的路径边界）
        const cwd = isCc ? (session.grantedDirs?.[0] ?? session.cwd ?? undefined) : (session.cwd ?? undefined);
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
          // 断连后没人能应答审批了：全部按拒绝收敛
          denyPendingPerms(session);
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
            toolTier: session.toolTier,
            cwd,
            allowedTools,
            resumeSessionId: session.ccSessionId,
            // 权限中枢：适配器要执行敏感操作前挂起等用户点头。发 SSE permission_request
            // 进前端抽屉；POST /sessions/:id/permission、120s 超时（approvalTimeoutMs）
            // 或回合取消（ac.signal /abort、断连）三条路径收敛；会话逐出走 dispose 的
            // denyPendingPerms。settle 幂等，promise 不悬挂、不重复清算。
            requestApproval: (action, summary) => new Promise((resolve) => {
              const reqId = randomUUID();
              let timer = null;
              const settle = (allow) => {
                session.pendingPerms.delete(reqId);
                if (timer) clearTimeout(timer);
                ac.signal.removeEventListener('abort', onAbort);
                resolve(allow);
              };
              const onAbort = () => settle(false);
              if (ac.signal.aborted) { resolve(false); return; }   // 死回合不再发权限帧
              session.pendingPerms.set(reqId, settle);
              ac.signal.addEventListener('abort', onAbort, { once: true });
              send('permission_request', { reqId, action, summary });
              timer = setTimeout(() => settle(false), approvalTimeoutMs);
              timer.unref?.();
            }),
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
          // 正常收尾时挂起表应为空；兜底收敛，防异常路径泄漏审批 promise
          denyPendingPerms(session);
          session.streaming = false;
          session.cancel = null;
          send('done', {});
          res.end();
        }
        return;
      }

      // 审批应答：前端抽屉点允许/拒绝 → 这里唤醒挂起的 requestApproval。
      // 未知会话 / 未知或已收敛的 reqId 都是 404（幂等重放按不存在处理）。
      const permMatch = req.method === 'POST' && url.pathname.match(SESSION_ROUTE['/permission']);
      if (permMatch) {
        const session = sessions.get(permMatch[1]);
        if (!session) return json(404, { error: 'unknown session' });
        const body = await readJson(req);
        const cb = session.pendingPerms.get(body?.reqId);
        if (!cb) return json(404, { error: 'unknown permission request' });
        session.pendingPerms.delete(body.reqId);
        cb(body.decision === 'allow');
        return json(200, { ok: true });
      }

      const abortMatch = req.method === 'POST' && url.pathname.match(SESSION_ROUTE['/abort']);
      if (abortMatch) {
        const session = sessions.get(abortMatch[1]);
        if (!session) return json(404, { error: 'unknown session' });
        log('turn', `${abortMatch[1].slice(0, 8)} ⏹ abort requested`);
        // 挂起的审批先按拒绝收敛（否则适配器悬在 requestApproval 上，promise 泄漏）
        denyPendingPerms(session);
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
