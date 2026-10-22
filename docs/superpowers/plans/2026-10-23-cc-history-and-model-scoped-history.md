# cc 会话历史上网页 + 历史不按模型分格 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 cc 自己的对话（思维链 + 正文）读出来显示在网页 chat 里；同时让换模型不再丢会话历史。

**Architecture:** 两个独立改动。(1) `GET /sessions` / `POST /sessions/clear` 的筛选从四维降到 `{agent, cwd}`——`provider`/`model` 仍是记录字段，从筛选键降级为展示元数据。(2) cc 适配器的 `restore()` 在读得到 CLI 的 jsonl 时，把 `type ∈ {user, assistant}` 的对话读出来，经**已有的** `POST /sessions` 响应契约（`material.messages`）返回，前端**已有的**渲染循环画出来。不改协议、不改存储格式、不每轮读盘。

**Tech Stack:** Astro 5 站点（`src/`）+ Node 网关（`packages/agent-server`，原生 `node:test`）；前端纯函数放 `src/lib/`，用 vitest 测。

**明确不做（spec 的「已知风险」节，本期只记录不动手）：** 不修「pi 跨 provider 恢复时，旧模型写进 `messages` 的块可能不被新 provider 接受」。表现是那一轮报错、历史不损坏、点「新对话」重开即可。要修就得猜「哪个块哪个 provider 要」，比让它报错更糟。**看到这类报错不要顺手加过滤逻辑。**

---

## File Structure

| 文件 | 职责 | 本计划做什么 |
|---|---|---|
| `packages/agent-server/src/adapters/cc.mjs` | cc 适配器（spawn `claude`） | `restore()` 读 jsonl；新增模块级 `readCcDialogue()` |
| `packages/agent-server/src/server.mjs` | 网关路由 | 两处 filter 的 key 列表 `['agent','cwd']` + 注释；400 文案 |
| `packages/agent-server/test/cc-adapter.test.mjs` | cc 适配器测试 | 新增 4 条 restore 读历史用例 |
| `packages/agent-server/test/transcripts.test.mjs` | 存储层测试 | 新增 2 条「能力保留」用例 |
| `packages/agent-server/test/server.test.mjs` | 网关端到端测试 | 新增 1 条「换模型恢复同一条」用例 |
| `src/lib/agentchat.ts` | 前端网络/纯函数层 | 新增 `historyBlocks()`、`sessionModelLabel()` |
| `src/lib/agentchat.test.ts` | 前端纯函数测试 | 新增两组 vitest 用例 |
| `src/pages/free-models.astro` | chat 页面 | 筛选降两维（4 处调用）；思维链渲染；列表行模型小标 |

**为什么 `historyBlocks()` 放 `src/lib/`**：`free-models.astro` 的脚本内联在 `.astro` 里，vitest（`include: ['src/**/*.test.*']`，`node` 环境）import 不到它，也没有 DOM。把「一组 content 块 → 一串 (role, text)」提成纯函数，页面调用、测试只测函数——与既有 `drawer.ts` / `prompt.ts` 同一模式。

---

## Task 1: 筛选降维（网关）—— 换模型不丢历史

**Files:**
- Modify: `packages/agent-server/src/server.mjs:189-196`（GET filter）、`:335-343`（clear filter + 400 文案）、`:274-277`（建会话处的注释）
- Test: `packages/agent-server/test/transcripts.test.mjs`、`packages/agent-server/test/server.test.mjs`

### 背景：为什么改这里

`server.mjs:190` 的注释写「筛选四维与 pi 的 cacheKey 一致：换模型不该串到别的模型的历史里」。这句话把两件事混为一谈：`cacheKey`（`pi.mjs:99`）是**内存 Agent 缓存**的键，换模型必须换 Agent（否则上一模型的上下文与凭据被带过去）；而记录里的 `model`/`provider` 只是「这条会话最后一次用什么跑的」元数据。两个可恢复适配器都**不**按模型分格：

- pi：`loadPersistedMessages`（`pi.mjs:125`）只校验 `rec.adapter === 'pi'`，messages 喂进 `initialState.messages`，Agent 用新模型重建；
- cc：`--resume <ccSessionId>`，模型由本次请求决定，CLI 原生跨模型续命。

所以 `model` 进筛选是我们自己加的约束，去掉即可。`provider` 一起去掉：本站的模型卡片是 `data-provider` + `data-model` 同一个 `chat-pick` 按钮，只去 `model` 的话「GLM 卡 → Claude 卡」照样丢历史。

- [ ] **Step 1: 写失败的测试（存储层能力保留）**

在 `packages/agent-server/test/transcripts.test.mjs` 末尾追加：

```javascript
// ── 筛选降维：网关不再按 model/provider 筛，但 store 的能力保留 ────────────
// 背景：2026-10-23 起 GET /sessions 只按 {agent, cwd} 筛（见 server.mjs 的
// filter 构造处）。**这不是把能力从 store 里删掉**——list()/clear() 仍支持
// 四维，只是网关不再传那两个参数。这两条用例就是凭证：谁要是顺手把 model
// 从 list() 的判断里删了，这里会红。
test('list({agent,cwd}) spans models and providers — the gateway no longer splits by them', (t) => {
  const { store } = tmpStore(t);
  const msg = [{ role: 'user', content: 'hi', timestamp: 1 }];
  store.save(base({ id: 'glm', provider: 'zai', model: 'glm-4.7-flash' }));
  store.save(base({ id: 'claude', provider: 'openrouter', model: 'claude-sonnet-5-5' }));
  store.save(base({ id: 'elsewhere', cwd: '/tmp/other' }));
  const hits = store.list({ agent: 'pi', cwd: '/tmp/x' });
  assert.deepEqual(hits.map((h) => h.id).sort(), ['claude', 'glm'],
    'a model switch must not hide the history — cwd is the boundary, not the model');
  assert.ok(!hits.some((h) => h.id === 'elsewhere'), 'cwd is still a real boundary');
  // 能力保留：同一个 store 上按四维筛仍只返回匹配的那条。
  assert.deepEqual(store.list({ agent: 'pi', cwd: '/tmp/x', provider: 'zai', model: 'glm-4.7-flash' })
    .map((h) => h.id), ['glm'], 'the four-dimension filter still works for callers that want it');
});

test('clear({agent,cwd}) spans models — capability unchanged', (t) => {
  const { store } = tmpStore(t);
  store.save(base({ id: 'glm', provider: 'zai', model: 'glm-4.7-flash' }));
  store.save(base({ id: 'claude', provider: 'openrouter', model: 'claude-sonnet-5-5' }));
  store.save(base({ id: 'keep', cwd: '/tmp/other' }));
  assert.equal(store.clear({ agent: 'pi', cwd: '/tmp/x' }), 2, 'both models cleared');
  assert.ok(store.get('keep'), 'a different cwd is untouched');
});
```

- [ ] **Step 2: 运行，确认通过（这两个用例现在就绿）**

Run: `cd packages/agent-server && node --test test/transcripts.test.mjs 2>&1 | tail -20`
Expected: 两条新用例 PASS（store 的能力本来就在）。**这一步的意义是确认「能力保留」不是空话**——后面网关改完，它们仍必须绿。

- [ ] **Step 3: 写失败的测试（网关真的不再按 model 筛）**

在 `packages/agent-server/test/server.test.mjs` 末尾追加：

```javascript
// 用户原话：「切换模型后如果没有换 agent，那会话历史应该不变」。
// 模型/provider 曾是筛选四维中的两维（server.mjs 的 filter 构造处），于是从
// GLM 卡切到 Claude 卡历史整排消失。二者已从筛选里退出，仍是记录字段
// （展示用）。这条钉住网关行为，不是 store 能力。
test('switching models does not lose the history: the list is scoped by agent+cwd only', async (t) => {
  const store = mkStore(t);
  const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
  const msg = [{ role: 'user', content: 'hi', timestamp: 1 }];
  // 同一目录、同一 agent，两个不同模型各一条历史
  store.save({ id: 'by-glm', agent: 'pi', cwd: '/tmp/x', provider: 'zai', model: 'glm-4.7-flash', lastUsed: 1, messages: msg });
  store.save({ id: 'by-claude', agent: 'pi', cwd: '/tmp/x', provider: 'openrouter', model: 'claude-sonnet-5-5', lastUsed: 2, messages: msg });
  store.save({ id: 'other-cwd', agent: 'pi', cwd: '/tmp/y', provider: 'zai', model: 'glm-4.7-flash', lastUsed: 3, messages: msg });
  store.save({ id: 'other-agent', agent: 'cc', cwd: '/tmp/x', provider: 'zai', model: 'glm-4.7-flash', lastUsed: 4, messages: msg });

  // 现在选的是 Claude：按 model 筛的话只剩 by-claude，GLM 那条会消失。
  const r = await json('/sessions?agent=pi&cwd=%2Ftmp%2Fx&provider=openrouter&model=claude-sonnet-5-5');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sessions.map((s) => s.id).sort(), ['by-claude', 'by-glm'],
    'a model switch must not hide the history');
  assert.ok(!r.body.sessions.some((s) => s.id === 'other-cwd'), 'cwd is still a boundary');
  assert.ok(!r.body.sessions.some((s) => s.id === 'other-agent'), 'agent is still a boundary');

  // provider/model 仍写进记录，但降级为展示元数据：列表 payload 里看得见。
  const glm = r.body.sessions.find((s) => s.id === 'by-glm');
  assert.equal(glm.provider, 'zai', 'provider is still recorded');
  assert.equal(glm.model, 'glm-4.7-flash', 'model is still recorded (the list row labels it)');
});

// 清空按钮的标签写的是「清空此目录的历史」——改后它真的只按目录清，
// 不再偷偷多带一个模型条件。
test('clearing this directory clears every model under it', async (t) => {
  const store = mkStore(t);
  const { json } = await withFauxServer(t, ['http://localhost:4321'], undefined, store);
  store.save({ id: 'a', agent: 'pi', cwd: '/tmp/x', provider: 'zai', model: 'glm-4.7-flash' });
  store.save({ id: 'b', agent: 'pi', cwd: '/tmp/x', provider: 'openrouter', model: 'claude-sonnet-5-5' });
  store.save({ id: 'c', agent: 'pi', cwd: '/tmp/y', provider: 'zai', model: 'glm-4.7-flash' });
  // 请求体仍带 provider/model（前端暂时没改）：必须被忽略，而不是筛掉 b。
  const r = await json('/sessions/clear', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ agent: 'pi', cwd: '/tmp/x', provider: 'zai', model: 'glm-4.7-flash' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.cleared, 2, 'both models under this cwd go');
  assert.ok(store.get('c'), 'a different cwd survives');
});
```

- [ ] **Step 4: 运行，确认这两条红**

Run: `cd packages/agent-server && node --test test/server.test.mjs 2>&1 | grep -E "^(not ok|ok) .*(switching models|clearing this directory)"`
Expected: 两条 `not ok`（`by-glm` 被 model 筛掉；`cleared` 是 1 而不是 2）。

- [ ] **Step 5: 改 GET /sessions 的筛选**

`packages/agent-server/src/server.mjs`，把 189-196 行：

```javascript
      // 历史列表：某配置下的会话，newest first，只带元数据（见 TranscriptStore.list）。
      // 筛选四维与 pi 的 cacheKey 一致：换模型不该串到别的模型的历史里。
      if (req.method === 'GET' && url.pathname === '/sessions') {
        const filter = {};
        for (const k of ['agent', 'cwd', 'provider', 'model']) {
          const v = url.searchParams.get(k);
          if (v != null && v !== '') filter[k] = v;
        }
```

替换为：

```javascript
      // 历史列表：某配置下的会话，newest first，只带元数据（见 TranscriptStore.list）。
      // 只按 agent + cwd 筛。曾经是四维（provider/model 也在内），注释写「与 pi 的
      // cacheKey 一致」——那把两件事混为一谈了：cacheKey（pi.mjs）是**内存 Agent
      // 缓存**的键，换模型必须换 Agent（否则上一模型的上下文与凭据被带过去）；
      // 而记录里的 model/provider 只是「这条会话最后一次用什么跑的」元数据。
      // 两个可恢复适配器都跨模型续命：pi 把 rec.messages 喂回 initialState.messages、
      // Agent 用新模型重建；cc 的 --resume 由本次请求定模型。按模型分格是我们自己
      // 加的约束，后果是换模型进 chat 历史整排消失（用户 2026-10-23 报的）。
      // provider/model 仍是记录字段（列表行拿它标模型），只是不再是筛选键。
      // list() 的四维能力保留：是这里不再传，不是 store 不再支持。
      if (req.method === 'GET' && url.pathname === '/sessions') {
        const filter = {};
        for (const k of ['agent', 'cwd']) {
          const v = url.searchParams.get(k);
          if (v != null && v !== '') filter[k] = v;
        }
```

- [ ] **Step 6: 改 POST /sessions/clear 的筛选与 400 文案**

同文件 335-343 行：

```javascript
        const filter = {};
        for (const k of ['agent', 'cwd', 'provider', 'model']) {
          if (typeof body?.[k] === 'string' && body[k]) filter[k] = body[k];
        }
        // 一个筛选条件都没认出来 = 请求体写错了（字段名拼错/类型不对）。
        // 转发空筛选会让 store.clear() 抛 TypeError（500），而把非法筛选悄悄
        // 丢掉再清全部更糟——按「请求有问题」明确拒掉。
        if (!Object.keys(filter).length) return json(400, { error: 'at least one of agent/cwd/provider/model is required' });
```

替换为：

```javascript
        const filter = {};
        for (const k of ['agent', 'cwd']) {
          if (typeof body?.[k] === 'string' && body[k]) filter[k] = body[k];
        }
        // 一个筛选条件都没认出来 = 请求体写错了（字段名拼错/类型不对）。
        // 转发空筛选会让 store.clear() 抛 TypeError（500），而把非法筛选悄悄
        // 丢掉再清全部更糟——按「请求有问题」明确拒掉。
        // 与 GET 同一边界：只按 agent/cwd 清。请求体里仍可能带 provider/model
        // （前端尚未改），被忽略而不是拿它再筛一遍——否则「清空此目录的历史」
        // 这个按钮实际只清一个模型下的，标签就成了谎话。
        if (!Object.keys(filter).length) return json(400, { error: 'at least one of agent/cwd is required' });
```

- [ ] **Step 7: 跑网关测试，确认新用例绿、旧用例没被带红**

Run: `cd packages/agent-server && node --test test/server.test.mjs 2>&1 | tail -25`
Expected: `# pass` 全绿（含 Step 3 的两条）。

⚠️ **已知会受影响的两条旧用例**，若红说明你改错了地方，不要改测试去迁就：
- `POST /sessions/clear clears only the given filter scope`（`:1167`）——它只传 `{cwd}`，本来就不含 model，应仍绿。
- `clear with no usable filter is a 400…`（`:1211`）——它断言 `{cwd: ''}` 等返回 400，仍成立；**不要**给它加 `{provider:'x'}` 这类现在合法的 body，那会改变用例的意图。

- [ ] **Step 8: 跑全量网关测试**

Run: `cd packages/agent-server && node --test test/*.test.mjs 2>&1 | tail -15`
Expected: 全绿。

- [ ] **Step 9: Commit**

```bash
git add packages/agent-server/src/server.mjs packages/agent-server/test/transcripts.test.mjs packages/agent-server/test/server.test.mjs
git commit -m "$(cat <<'EOF'
fix(gw): session history survives a model switch — scope the list by agent+cwd

GET /sessions and POST /sessions/clear filtered on agent/cwd/provider/model.
The comment said the four had to match pi's cacheKey, which conflates two
different things: cacheKey is the in-memory Agent cache key (switching models
must rebuild the Agent), while the record's model/provider are just metadata
about what a history last ran on. Both restorable adapters resume across
models natively — pi feeds rec.messages back into initialState.messages with
a newly built Agent, cc passes --resume and takes the model from the request.

Scoping by model meant switching models emptied the whole list. Drop those
two dimensions from the filter; they stay record fields so the list row can
label which model a history last used.

list()/clear() keep their four-dimension capability — the gateway simply
stops passing it. Pinned by tests.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: cc 的 restore 把历史一起带回来

**Files:**
- Modify: `packages/agent-server/src/adapters/cc.mjs`（`restore()` 与新增 `readCcDialogue()`）
- Test: `packages/agent-server/test/cc-adapter.test.mjs`

### 背景

cc 的历史在 CLI 自己的 `<configDir>/projects/<cwd-slug>/<ccSessionId>.jsonl` 里，我们的记录只留 `configDir` + `ccSessionId` 两个指针（`9e35bb7` 起如此）。`restore()` 现在返回 `{configDir, ccSessionId}`，前端因此显示一行「历史不在网页里显示」。

实测那份 jsonl：26 行 / 213.3 KB，其中对话只有 3 行 / 433 字符（0.2%），其余是 `attachment`、`api-request-blob`（其中一行带 8474 字符的 system prompt）等噪声。判据是**行首的 `type` 字段**（`type ∈ {user, assistant}`）——**不能按 `message.role` 筛**，噪声行也带 role。cc 的 content block 就是 Anthropic 标准形状，与 pi 存进 `rec.messages` 的同形，**无需转换**。

- [ ] **Step 1: 写失败的测试**

在 `packages/agent-server/test/cc-adapter.test.mjs` 末尾追加（先确认文件顶部已 import `writeFileSync` / `mkdirSync` / `rmSync`——第 3 行已有，无需新增）：

```javascript
// ── restore 把 CLI 的对话读回来（2026-10-23）───────────────────────────────
// cc 的历史在 CLI 自己的 projects/<slug>/<id>.jsonl 里，我们的记录只有指针。
// restore() 读它，经 POST /sessions 已有的 material.messages 契约交出去，
// 网页于是能画出思维链 + 正文。判据是行首 type（user/assistant）——
// 实测噪声行（api-request-blob 之类）也带 message.role，按 role 筛会把
// 8474 字符的 system prompt 当用户消息渲染出来。

// 造一个假 configDir + 一份最小 jsonl。行序即真实对话序。
const plantTranscript = (dir, sessionId, lines) => {
  mkdirSync(join(dir, 'projects', 'fake-slug'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'fake-slug', `${sessionId}.jsonl`), lines.join('\n') + '\n');
};

const DIALOGUE_LINES = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '写一个贪吃蛇' }] } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: '先想清楚游戏循环' },
    { type: 'text', text: '好的，我来写。' },
  ] } }),
];

test('cc restore reads the dialogue out of the CLI jsonl', (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  plantTranscript(dir, 'sess-x', [
    ...DIALOGUE_LINES,
    // 噪声：attachment 没有 message；api-request-blob 带 message.role —— 按 role 筛会中招
    JSON.stringify({ type: 'attachment', attachment: { type: 'x' } }),
    JSON.stringify({ type: 'api-request-blob', message: { role: 'user', content: 'x'.repeat(8474) } }),
    JSON.stringify({ type: 'queue-operation', operation: 'add' }),
  ]);
  store.save({ id: 'sess-x', adapter: 'cc', ccSessionId: 'sess-x', configDir: dir });

  const restored = cc.restore('sess-x');
  assert.deepEqual(restored.messages, [
    { role: 'user', content: [{ type: 'text', text: '写一个贪吃蛇' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '先想清楚游戏循环' },
      { type: 'text', text: '好的，我来写。' },
    ] },
  ], 'only the dialogue lines, blocks passed through verbatim');
  // 指针照旧给：下一轮 --resume 仍要靠它们。
  assert.equal(restored.ccSessionId, 'sess-x');
  assert.equal(restored.configDir, dir);
});

// 按 role 筛的回归防线：噪声行同样带 role。
test('cc restore ignores noise lines that also carry a role', (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  plantTranscript(dir, 'sess-y', [
    JSON.stringify({ type: 'api-request-blob', message: { role: 'user', content: 'system prompt…' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
  ]);
  store.save({ id: 'sess-y', adapter: 'cc', ccSessionId: 'sess-y', configDir: dir });
  assert.deepEqual(cc.restore('sess-y').messages,
    [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    'type decides, not message.role');
});

// 绝不返回空数组：那会让前端画出「已恢复历史对话，0 条消息」的假横幅。
// 宁可退回指针-only（前端照现在的提示走），不假装有历史。
test('cc restore falls back to pointers alone when the jsonl is gone', (t) => {
  const store = mkStore(t);
  const cc = createCcAdapter({ cliPath: FIXTURE, transcripts: store });
  const dir = mkdtempSync(join(tmpdir(), 'atbx-cc-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 目录在、但里面没有 jsonl（被手删 / 被清）
  store.save({ id: 'sess-z', adapter: 'cc', ccSessionId: 'gone', configDir: dir });
  assert.deepEqual(cc.restore('sess-z'), null, 'no transcript file at all: not restorable');
  // 有文件、但一行对话都没有
  plantTranscript(dir, 'sess-z2', [JSON.stringify({ type: 'attachment' })]);
  store.save({ id: 'sess-z2', adapter: 'cc', ccSessionId: 'sess-z2', configDir: dir });
  const r = cc.restore('sess-z2');
  assert.equal(r.messages, undefined, 'no dialogue lines: omit messages, do not return []');
  assert.equal(r.ccSessionId, 'sess-z2', '--resume still gets its pointers');
});
```

- [ ] **Step 2: 运行，确认红**

Run: `cd packages/agent-server && node --test test/cc-adapter.test.mjs 2>&1 | grep -E "^not ok" `
Expected: 3 条 `not ok`（`restored.messages` 是 `undefined`）。

- [ ] **Step 3: 在 cc.mjs 里实现读取**

先加模块级函数。在 `packages/agent-server/src/adapters/cc.mjs` 里 `findCcTranscript` 的定义（`:407`）**之前**插入：

```javascript
// 从 CLI 的 jsonl 里把对话读出来。返回 [{role, content}]（与 pi 存进
// rec.messages 的形状逐字段一致，前端同一条渲染路径），或 null（读不到 /
// 一行对话都没有）。
//
// 判据是**行首的 type 字段**，不是 message.role：实测噪声行也带 role——
// api-request-blob 的 message.role 就是 'user'，按 role 筛会把 8474 字符的
// system prompt 当用户消息渲染出来（2026-10-23 实测一份真实 transcript）。
// type ∈ {user, assistant} 才是 CLI 写下的对话。
//
// 只在 restore() 里调一次（POST /sessions 时），绝不每轮读、也绝不把内容
// 搬进我们的记录：权威副本只有 CLI 那一份，存第二份就有了两个可能不一致
// 的真源。记录继续只留 configDir + ccSessionId 两个指针。
function readCcDialogue(configDir, ccSessionId) {
  if (!configDir || !ccSessionId) return null;
  const projects = join(configDir, 'projects');
  let slugs;
  try { slugs = readdirSync(projects, { withFileTypes: true }); } catch { return null; }
  const target = `${ccSessionId}.jsonl`;
  for (const d of slugs) {
    if (!d.isDirectory()) continue;
    const file = join(projects, d.name, target);
    let raw;
    try { raw = readFileSync(file, 'utf8'); } catch { continue; } // 别的 slug：继续找
    const out = [];
    // 逐行 parse，单行坏了只丢那一行——一份 213 KB 的文件不该因为末尾半行
    // 而整个读不出来。
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj?.type !== 'user' && obj?.type !== 'assistant') continue;
      const msg = obj.message;
      if (!msg || typeof msg !== 'object') continue;
      // content 必须是块数组（Anthropic 标准形状）；字符串 content 也见得过，
      // 原样留着让前端按字符串路径渲染。
      const content = msg.content;
      if (!Array.isArray(content) && typeof content !== 'string') continue;
      out.push({ role: obj.type, content });
    }
    // 一行对话都没有 → 当没读到（调用方据此只回指针，不返回空数组）
    return out.length ? out : null;
  }
  return null;
}
```

再把 `restore()`（`:394`）从：

```javascript
    restore(sessionId) {
      const rec = transcripts?.get(sessionId);
      if (!rec?.configDir || !rec?.ccSessionId) return null;
      if (!existsSync(rec.configDir)) return null;
      return findCcTranscript(rec.configDir, rec.ccSessionId)
        ? { configDir: rec.configDir, ccSessionId: rec.ccSessionId }
        : null;
    },
```

改为：

```javascript
    restore(sessionId) {
      const rec = transcripts?.get(sessionId);
      if (!rec?.configDir || !rec?.ccSessionId) return null;
      if (!existsSync(rec.configDir)) return null;
      if (!findCcTranscript(rec.configDir, rec.ccSessionId)) return null;
      // 读得到对话就一并带上：网页于是能显示思维链 + 正文，与 pi 一致。
      // 读不到（jsonl 没了 / 一行对话都没有）就只回指针——--resume 照常续
      // 上下文，前端照「已接上本机的 Claude Code 会话」提示走。
      // **绝不回空数组**：那会画出「已恢复历史对话，0 条消息」的假横幅，
      // 比不显示更糟。
      const dialogue = readCcDialogue(rec.configDir, rec.ccSessionId);
      return {
        configDir: rec.configDir, ccSessionId: rec.ccSessionId,
        ...(dialogue ? { messages: dialogue } : {}),
      };
    },
```

⚠️ `readFileSync` 必须在 cc.mjs 的 import 列表里。先确认：

```bash
grep -n "^import" packages/agent-server/src/adapters/cc.mjs
```

若没有 `readFileSync`，把该行改成包含它（保持其余导入不变）。

- [ ] **Step 4: 运行，确认绿**

Run: `cd packages/agent-server && node --test test/cc-adapter.test.mjs 2>&1 | tail -15`
Expected: 全绿，含 3 条新用例。

⚠️ 既有那条 `cc adapter persists ccSessionId and config dir into the transcript store`（`:394`）断言 `assert.deepEqual(restored, { configDir: rec.configDir, ccSessionId: 'fake-sess-1' })`——它 plant 的 jsonl 内容是 `'{}\n'`（一行 `{}`，不是对话）。`readCcDialogue` 对 `{}` 返回 `null`（`obj?.type` 既不是 user 也不是 assistant），所以 `messages` 不会被加上，该断言仍成立。**不要改那条测试。**

- [ ] **Step 5: 跑全量网关测试**

Run: `cd packages/agent-server && node --test test/*.test.mjs 2>&1 | tail -15`
Expected: 全绿。

（变异测试见 Step 9——在 commit 之后做，原因见那里。）

- [ ] **Step 6: 确认 readCcDialogue 只有 restore 一个调用方**

Run: `grep -n "readCcDialogue" packages/agent-server/src/adapters/cc.mjs`
Expected: 恰好 2 行（定义、restore 内）。多了说明有人每轮在读。

「只在恢复时读」这条性质**没有测试能看着**（每轮读一遍不会破坏任何断言），所以它靠的是这个 grep + Step 8 的 commit 内容。谁要是把调用加到 turn_end 里，这一行 grep 会多出来。

- [ ] **Step 7: 跑一遍 cc 的恢复测试，确认没有 console 噪声**

Run: `cd packages/agent-server && node --test test/cc-adapter.test.mjs 2>&1 | grep -iE "warn|unhandled|deprecat" | head`
Expected: 无输出（或只有与本改动无关的既有噪声）。

读文件是新引入的 I/O：若路径拼错，`readFileSync` 的 ENOENT 被 `catch` 吞掉、
测试会以「没有 messages」的形式失败——看起来像判据错了，实际是没读到文件。
跑一次带 `--test-reporter=spec` 的：

Run: `cd packages/agent-server && node --test --test-reporter=spec test/cc-adapter.test.mjs 2>&1 | grep -A3 "restore reads"`
Expected: 该用例名出现在 ✔ 列表里，且耗时是个位数毫秒（文件在 tmp 里）。

- [ ] **Step 8: Commit**

```bash
git add packages/agent-server/src/adapters/cc.mjs packages/agent-server/test/cc-adapter.test.mjs
git commit -m "$(cat <<'EOF'
feat(cc): restore() brings the CLI's own dialogue back to the web chat

cc keeps its history in its own projects/<slug>/<id>.jsonl; our record only
holds the two pointers, so the web chat showed one line saying the history
was not displayed. restore() now reads the dialogue and returns it through
the existing material.messages path on POST /sessions — no protocol change,
and the content stays owned by the CLI: read once on restore, never per
turn, never copied into our record.

Lines are selected by their leading type field (user/assistant), not by
message.role — noise lines carry roles too, and filtering by role rendered
an 8474-char system prompt as a user message in a real transcript.

cc's content blocks are already the Anthropic standard shape, identical to
what pi stores, so they pass through verbatim. When the jsonl is missing or
holds no dialogue, restore() returns the pointers alone rather than an empty
array — an empty array would draw a "restored 0 messages" banner, which is
worse than saying nothing.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: 变异测试——两个声称各杀一次（commit 之后做）**

⚠️ **必须在 Step 8 的 commit 之后做。** 还原手段是 `git checkout -- <file>`，它把工作区恢复成 **HEAD**；在 commit 之前做会把刚写的实现一起抹掉。

1. 按 role 筛（杀「type 才是判据」）：
   把 `if (obj?.type !== 'user' && obj?.type !== 'assistant') continue;` 改成 `if (msg?.role !== 'user' && msg?.role !== 'assistant') continue;`
   Run: `cd packages/agent-server && node --test test/cc-adapter.test.mjs 2>&1 | grep -c "^not ok"`
   Expected: ≥ 1，且 `cc restore ignores noise lines that also carry a role` 在内
   还原：`git checkout -- packages/agent-server/src/adapters/cc.mjs`

2. 读不到时返回空数组（杀「不假装有历史」）：
   把 `return out.length ? out : null;` 改成 `return out;`
   Run: `cd packages/agent-server && node --test test/cc-adapter.test.mjs 2>&1 | grep -c "^not ok"`
   Expected: ≥ 1，且 `falls back to pointers alone when the jsonl is gone` 在内
   还原：`git checkout -- packages/agent-server/src/adapters/cc.mjs`

每次还原后跑一次 `cd packages/agent-server && node --test test/cc-adapter.test.mjs 2>&1 | tail -5`，确认回到全绿再收尾。

---

## Task 3: 前端 —— 思维链渲染 + 模型小标 + 筛选降两维

**Files:**
- Modify: `src/lib/agentchat.ts`（新增 2 个纯函数）、`src/lib/agentchat.test.ts`（测试）
- Modify: `src/pages/free-models.astro`（4 处筛选调用、恢复渲染循环、列表行）

### 背景

`free-models.astro` 的脚本内联在 `.astro` 里，vitest（`include: ['src/**/*.test.*']`、`node` 环境）import 不到它。所以把要测的逻辑提成 `src/lib/agentchat.ts` 里的纯函数——与既有 `drawer.ts` / `prompt.ts` 同一模式。

- [ ] **Step 1: 写失败的测试（vitest）**

在 `src/lib/agentchat.test.ts` 末尾追加（先看文件现有 import 行，把两个新函数加进去）：

```typescript
// ── 恢复历史的渲染分流（2026-10-23）──────────────────────────────────────
// cc 的历史现在会进网页（见网关 cc.restore）。恢复渲染循环此前把非 text 块
// 画成 `[${blk.type}]`，思维链于是显示成 `[thinking]`。用户已确认选 A：
// 思维链与正文都显示，与 CLI 一致。逻辑提成纯函数，页面只负责接线——
// .astro 里的脚本 import 不进来，node 环境也没有 DOM。
describe('historyBlocks', () => {
  it('splits thinking from text and keeps the original order', () => {
    const blocks = [
      { type: 'thinking', thinking: '先想清楚' },
      { type: 'text', text: '好的' },
    ];
    assert.deepEqual(historyBlocks(blocks), [
      { kind: 'thinking', text: '先想清楚' },
      { kind: 'text', text: '好的' },
    ]);
  });

  it('keeps string content as one text block', () => {
    assert.deepEqual(historyBlocks('plain'), [
      { kind: 'text', text: 'plain' },
    ]);
  });

  it('labels images and unknown blocks without inventing content', () => {
    assert.deepEqual(historyBlocks([{ type: 'image' }, { type: 'tool_use' }]), [
      { kind: 'image', text: '[图片]' },
      { kind: 'unknown', text: '[tool_use]' },
    ]);
  });

  it('skips blocks it cannot say anything about', () => {
    assert.deepEqual(historyBlocks([null, {}, { type: 'text' }]), [
      { kind: 'text', text: '' },
    ]);
  });
});

// 筛选不再按模型分格，列表里会混着不同模型的会话——标出来才知道这条
// 上次是谁跑的（记录里本来就有 model 字段）。
describe('sessionModelLabel', () => {
  it('shows the model when known', () => {
    assert.equal(sessionModelLabel({ model: 'glm-4.7-flash' } as SessionSummary), 'glm-4.7-flash');
  });
  it('says nothing rather than guessing when the record has no model', () => {
    assert.equal(sessionModelLabel({ model: '' } as SessionSummary), '');
    assert.equal(sessionModelLabel({} as SessionSummary), '');
  });
});
```

在文件顶部 import 行补上两个函数与 `SessionSummary`（该类型文件里应已 import；若没有则一并加）。

- [ ] **Step 2: 运行，确认红**

Run: `npx vitest run src/lib/agentchat.test.ts 2>&1 | tail -20`
Expected: FAIL — `historyBlocks is not a function` / `sessionModelLabel is not a function`

- [ ] **Step 3: 实现两个纯函数**

在 `src/lib/agentchat.ts` 末尾追加：

```typescript
/**
 * 把一条历史消息的 content 拆成渲染用的块序列。
 *
 * 恢复渲染循环此前把非 text 块画成 `[${blk.type}]`，思维链于是显示成
 * `[thinking]`。cc 的 block 是 Anthropic 标准形状（`{type:'text',text}` /
 * `{type:'thinking',thinking}`），与 pi 存进 messages 的完全一致，故这里
 * 只做分流、不做转换。
 *
 * 提成纯函数是因为 `free-models.astro` 的脚本内联在 .astro 里，vitest
 * import 不到（node 环境也没有 DOM）——与 drawer.ts / prompt.ts 同一模式。
 */
export type HistoryBlock =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'image'; text: string }
  | { kind: 'unknown'; text: string };

export function historyBlocks(content: unknown): HistoryBlock[] {
  // 字符串 content（少数模型/早期记录）：一条正文，不必假装有块结构。
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const out: HistoryBlock[] = [];
  for (const raw of content) {
    const blk = raw as { type?: unknown; text?: unknown; thinking?: unknown } | null;
    const type = blk && typeof blk === 'object' ? blk.type : undefined;
    if (type === 'thinking') out.push({ kind: 'thinking', text: String(blk!.thinking ?? '') });
    else if (type === 'text') out.push({ kind: 'text', text: String(blk!.text ?? '') });
    else if (type === 'image') out.push({ kind: 'image', text: '[图片]' });
    // 其他未知块：只报类型名，不编内容。缺 type 的（null / {}）什么都说不出，跳过。
    else if (typeof type === 'string') out.push({ kind: 'unknown', text: `[${type}]` });
  }
  return out;
}

/**
 * 历史列表行的模型小标。记录里本来就有 model 字段（曾是筛选键，现降级为
 * 展示元数据）；拿不到就返回空串，由调用方不渲染这个 span——不猜、不显示「未知」。
 */
export function sessionModelLabel(s: Pick<SessionSummary, 'model'> | Record<string, unknown>): string {
  const m = (s as { model?: unknown }).model;
  return typeof m === 'string' ? m : '';
}
```

- [ ] **Step 4: 运行，确认绿**

Run: `npx vitest run src/lib/agentchat.test.ts 2>&1 | tail -12`
Expected: PASS（含新用例）。

- [ ] **Step 5: 页面接线 —— 恢复渲染循环**

`src/pages/free-models.astro`，把 `:746-754` 这段：

```typescript
      for (const m of res.messages!) {
        if (m.role !== 'user' && m.role !== 'assistant') continue; // 跳过 system / tool 行
        const text = Array.isArray(m.content)
          ? m.content.map((b) => {
              const blk = b as { type?: string; text?: string };
              return blk.type === 'text' ? blk.text ?? '' : blk.type === 'image' ? '[图片]' : `[${blk.type}]`;
            }).join('')
          : String(m.content ?? '');
        chatMsg(m.role as 'user' | 'assistant', text);
      }
```

替换为：

```typescript
      for (const m of res.messages!) {
        if (m.role !== 'user' && m.role !== 'assistant') continue; // 跳过 system / tool 行
        // 思维链与正文分开画（用户选 A：与 CLI 一致）。顺序即 content 里的
        // 原始次序——先想后说是模型自己的顺序，别重排。
        for (const blk of historyBlocks(m.content)) {
          if (blk.kind === 'text') chatMsg(m.role as 'user' | 'assistant', blk.text);
          else if (blk.kind === 'thinking') chatMsg('thinking', blk.text);
          else chatMsg('hint', blk.text); // 图片 / 未知块：一行说明，不抢正文
        }
      }
```

并把 `historyBlocks` 加进 `:315` 那行的 import 列表。

- [ ] **Step 6: 页面接线 —— 列表行模型小标**

同文件 `:596-600` 附近（`main` 建好之后、`item.append` 之前）插入：

```typescript
      // 模型小标：筛选不再按模型分格（见网关的 filter 构造处），列表里会混着
      // 不同模型的会话，标出来才知道这条上次是谁跑的。记录里本来就有 model。
      const model = sessionModelLabel(s);
      if (model) {
        const tag = document.createElement('span');
        tag.className = 'chat-session-item-model';
        tag.textContent = model;
        main.append(tag);
      }
```

`item.append(main, time, del)` 保持原样（`tag` 挂在 `main` 里，不占布局位）。

在 CSS 区（`.chat-session-item-main` 那条附近，约 `:243`）加一条：

```css
  .chat-session-item-model { flex: 0 0 auto; margin-left: .35rem; color: var(--ink-soft); font-size: .72rem; font-family: var(--font-mono); }
```

把 `sessionModelLabel` 也加进 `:315` 那行的 import。

- [ ] **Step 7: 页面接线 —— 四处筛选降到两维**

把 `:654`（refreshSessionList）、`:698`（ensureSession 的自动恢复）、`:914` 与 `:917`（sessionClearBtn）四处调用里的 `provider: c.provider, model: c.model` 删掉，只留 `agent` 与 `cwd`：

```typescript
    sessionSummaries = await listSessions({ agent: c.agent ?? c.agents[0] ?? 'pi', cwd: c.cwd });
```

四处都改成这个形状（`:917` 的 `left` 那次同理）。`:698` 那处就是自动恢复的取材点——`list.find(canRestore)?.id` 现在会变成「同 agent 同目录下最近一条说过话的」，换模型进 chat 因此接上同一条会话，需求就此满足，无需再改逻辑。

`listSessions` / `clearSessions` 的签名（`src/lib/agentchat.ts:253`、`:273`）里 `provider` / `model` 仍是可选字段——留着，前端暂时不传而已；网关忽略它们。不要改签名。

顺手把 `refreshSessionList` 上方那段「工作目录为空时网关按不过滤处理」的注释保留——它仍然成立。

- [ ] **Step 8: 类型检查 + 构建**

Run: `npx astro check 2>&1 | tail -20`（若项目没有 `astro check` 脚本则跑 `npx tsc --noEmit 2>&1 | tail -20`）
Expected: 无新增错误。

Run: `npx astro build 2>&1 | tail -12`
Expected: 构建成功。

- [ ] **Step 9: 前端全量测试**

Run: `npx vitest run 2>&1 | tail -15`
Expected: 全绿。

- [ ] **Step 10: Commit**

```bash
git add src/lib/agentchat.ts src/lib/agentchat.test.ts src/pages/free-models.astro
git commit -m "$(cat <<'EOF'
feat(site): draw restored thinking as thinking, label each history row with its model

The resume render loop drew every non-text block as [type], so a restored
thinking block showed up as "[thinking]". Split the blocks through a pure
historyBlocks() helper: thinking gets the same .chat-msg--thinking styling
the live SSE stream uses, images and unknown blocks stay a one-line label,
and the original order is preserved — the model decides when to think.

The session list is no longer scoped by model (gateway change), so a list
now mixes models. Label each row with the model it last ran on; the field
was already in the record.

The helper lives in src/lib because a page's inline script cannot be
imported by vitest, and the test env has no DOM — same pattern as
drawer.ts / prompt.ts.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 端到端 + 人工验收

**Files:**
- Test: `packages/agent-server/test/server.test.mjs`

### 背景

前三个任务各自绿，但「换模型后恢复同一条会话」这件事要一条端到端用例钉住——它是这次需求的核心，也是把两个改动接起来的唯一路径。用既有的 fake-claude 夹具，不 spawn 真 CLI。

- [ ] **Step 1: 写失败的测试**

在 `packages/agent-server/test/server.test.mjs` 末尾追加：

```javascript
// 端到端：换模型后恢复的是同一条会话，且历史消息一起来了。
// 这是两个改动的交汇点——筛选降维（同目录跨模型可见）+ cc restore 读 jsonl。
// 用 fake-claude 夹具，不 spawn 真 CLI。
test('switching models resumes the same cc session, with its dialogue', async (t) => {
  const dir = freshDir();
  try {
    const store = new TranscriptStore({ dir });
    const registry = createRegistry([createCcAdapter({
      cliPath: join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude.sh'),
      transcripts: store,
    })]);
    const srv = await startServer({
      port: 0, allowedOrigins: ['http://localhost:4321'], registry,
      acpProbe: async () => false, transcripts: store,
    });
    t.after(() => srv.close());
    const base = `http://127.0.0.1:${srv.port}`;
    const json = async (path, opts = {}) => {
      const res = await fetch(base + path, { ...opts, headers: { Origin: 'http://localhost:4321', ...(opts.headers ?? {}) } });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    // 第一轮：用模型 A 建会话、发一轮，让 cc 适配器在 turn_end 写下 ccSessionId
    const first = await json('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter', model: 'm:free', agent: 'cc', cwd: '/tmp', toolTier: 'read' }),
    });
    assert.equal(first.status, 200);
    const id = first.body.sessionId;
    await fetch(`${base}/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ text: 'hi' }),
    }).then((r) => r.text());
    const rec = store.get(id);
    assert.equal(rec.ccSessionId, 'fake-sess-1', 'the first turn completed');

    // 种一份 CLI 的 jsonl：restore() 靠它把历史读出来
    mkdirSync(join(rec.configDir, 'projects', 'slug'), { recursive: true });
    writeFileSync(join(rec.configDir, 'projects', 'slug', 'fake-sess-1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n'
      + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: '想一下' }, { type: 'text', text: 'PONG' }] } }) + '\n');

    // 换模型再进：模型 B。断言恢复的是**同一条**会话，且带着历史消息。
    const second = await json('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openrouter', model: 'other:free', agent: 'cc', cwd: '/tmp',
        toolTier: 'read', persistId: id,
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.sessionId, id, 'the same session, not a new one');
    assert.equal(second.body.resumed, true, 'it really resumed');
    assert.deepEqual(second.body.messages, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: '想一下' }, { type: 'text', text: 'PONG' }] },
    ], 'the dialogue came back with it');
    // 模型是记录里的展示元数据：被更新成「最近一次用的」，不是筛选键。
    assert.equal(store.get(id).model, 'other:free', 'model is recorded, not filtered on');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

确认该文件顶部已有 `mkdirSync` / `writeFileSync` 的 import（与 `server.test.mjs` 的 `:975` 那段同样的写法，照抄即可）。

- [ ] **Step 2: 运行，确认绿（前三个任务的代码已就位）**

Run: `cd packages/agent-server && node --test test/server.test.mjs 2>&1 | grep -E "switching models resumes"`
Expected: `ok … switching models resumes the same cc session, with its dialogue`

**若它是红的**，说明前面某个任务没做对，不要改这条测试——回去看哪一步跳过了。

- [ ] **Step 3: 变异测试——把 model 加回筛选**

`packages/agent-server/src/server.mjs` 的 GET filter 里，把 `['agent', 'cwd']` 改成 `['agent', 'cwd', 'model']`：

Run: `cd packages/agent-server && node --test test/server.test.mjs 2>&1 | grep -cE "^not ok"`
Expected: ≥ 1

然后用 `node --test test/server.test.mjs 2>&1 | grep -E "^not ok"` 看清是哪几条红的。**必须是** `switching models does not lose the history` 或 `clearing this directory clears every model under it`（Task 1 Step 3 那两条）。

**Step 2 的端到端用例红不红都正常，别拿它当判据**：它走的是「显式传 persistId」，网关按 id 直接恢复，绕过列表筛选——加回 `model` 不影响这条路。它的作用是钉住「恢复成功且带着历史」，筛不筛得到由 Task 1 那两条看着。

还原：`git checkout -- packages/agent-server/src/server.mjs`

- [ ] **Step 4: 人工验收**

```bash
cd /home/dengzh/AI/agent-site && astro dev --background
astro dev status
```

然后人工走一遍（用真 cc 跑一轮）：

1. 选一个标了 `cc` 的模型卡 → Chat，Agent 选 Claude Code，填工作目录，发一句话。
2. 关抽屉重开，或刷新页面：日志区应显示**思维链（斜体、可折叠）+ 正文**，不是一行「历史不在网页里显示」，也不是 `[thinking]`。
3. 历史列表那行右侧应有一个小号等宽字体的模型名。
4. 切到另一个模型卡 → Chat，Agent 仍选 Claude Code：**历史列表应不变**（同目录同 agent 的会话都还在），且默认恢复的是最近那一条，由新模型接着答。
5. 点「清空此目录的历史」：同目录下所有模型的历史都清掉（提示的条数应含多个模型）。
6. 异常路径：把 `~/.config/agenttoolbox/sessions/<id>.cc/projects/` 下那个 jsonl 改名，再恢复该会话 → 应回到「已接上本机的 Claude Code 会话」的提示，不画「已恢复历史对话，0 条消息」。

验收完 `astro dev stop`。

- [ ] **Step 5: Commit（若有验收中的小修）**

按实际改动提交；无改动则本任务不产生 commit（测试已在 Step 2 前随 Task 1/2 提交）。

---

## 收尾

- [ ] 全量测试：`cd packages/agent-server && node --test test/*.test.mjs 2>&1 | tail -8` + `npx vitest run 2>&1 | tail -8`
- [ ] `git log --oneline main..HEAD` 应显示 3-4 个 commit，每个都自带变异测试证据
- [ ] 告我「实现完成」，由你决定要不要 push / 合并到 main
