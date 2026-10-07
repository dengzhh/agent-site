import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { createPiAdapter } from '../src/adapters/pi.mjs';

const collect = async (iter) => { const out = []; for await (const e of iter) out.push(e); return out; };

function fauxSetup() {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  return { models, faux };
}

test('pi adapter streams deltas then turn_end', async () => {
  const { models, faux } = fauxSetup();
  faux.setResponses([fauxAssistantMessage([fauxText('hi from pi')])]);
  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
  });
  const events = await collect(pi.run({
    messages: [{ role: 'user', content: 'hi' }],
    request: { provider: 'faux', model: 'faux' },
    apiKey: null,
  }));
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'hi from pi');
  assert.ok(events.some((e) => e.type === 'turn_end'));
});

test('pi adapter surfaces provider errors as error events', async () => {
  const { models, faux } = fauxSetup();
  // faux 队列为空 → provider 报错
  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
  });
  const events = await collect(pi.run({
    messages: [{ role: 'user', content: 'hi' }],
    request: { provider: 'faux', model: 'faux' },
    apiKey: null,
  }));
  assert.ok(events.some((e) => e.type === 'error'), 'error event present');
});

test('pi adapter reports available', async () => {
  const { models } = fauxSetup();
  const pi = createPiAdapter({ models, resolve: () => ({}) });
  assert.equal(await pi.available(), true);
});

test('pi adapter terminates when prompt settles with no events', async () => {
  const { models, faux } = fauxSetup();
  const pi = createPiAdapter({
    models,
    resolve: () => ({ model: faux.getModel(), providerId: faux.provider.id }),
  });
  // 不该挂起：即便 provider 立刻失败也要在合理时间内结束
  const events = await Promise.race([
    collect(pi.run({ messages: [{ role: 'user', content: 'x' }], request: {}, apiKey: null })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('adapter hung')), 5000)),
  ]);
  assert.ok(Array.isArray(events));
});
