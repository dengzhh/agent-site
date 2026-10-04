import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { startServer } from '../src/server.mjs';

// 每个测试起独立 server + faux provider
async function withFauxServer(t, origins = ['http://localhost:4321']) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const resolve = () => ({ model: faux.getModel(), providerId: faux.provider.id });
  const srv = await startServer({ port: 0, allowedOrigins: origins, resolve, models });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const json = async (path, opts) => {
    const res = await fetch(base + path, opts);
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  return { srv, base, json, faux, models };
}

test('health returns ok + version', async (t) => {
  const { json } = await withFauxServer(t);
  const { status, body } = await json('/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
});

test('CORS: allowed origin passes, unknown origin blocked', async (t) => {
  const { json } = await withFauxServer(t, ['https://dengzhh.github.io']);
  const good = await json('/health', { headers: { Origin: 'https://dengzhh.github.io' } });
  assert.equal(good.status, 200);
  const bad = await json('/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.status, 403);
});

test('preflight includes PNA header', async (t) => {
  const { base } = await withFauxServer(t);
  const res = await fetch(base + '/sessions', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:4321',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Private-Network': 'true',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
});

test('session + message round-trip streams SSE', async (t) => {
  const { json, base, faux } = await withFauxServer(t);
  faux.setResponses([fauxAssistantMessage([fauxText('Hello from faux!')])]);
  const create = await json('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ provider: 'faux', model: 'faux' }),
  });
  assert.equal(create.status, 200);
  const { sessionId } = create.body;

  const res = await fetch(`${base}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const raw = await res.text();
  const events = raw.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
  const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.equal(deltas, 'Hello from faux!');
  assert.ok(events.some((e) => e.type === 'turn_end'));
  assert.equal(events.at(-1).type, 'done');
});

test('unknown session 404, malformed JSON 400', async (t) => {
  const { json } = await withFauxServer(t);
  assert.equal((await json('/sessions/nope/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify({ text: 'x' }),
  })).status, 404);
  assert.equal((await json('/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://localhost:4321' },
    body: '{oops',
  })).status, 400);
});
