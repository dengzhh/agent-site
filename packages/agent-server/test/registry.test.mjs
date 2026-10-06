import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/adapters/registry.mjs';

const fake = (id, available = true) => ({
  id,
  available: async () => available,
  run: async function* () { yield { type: 'done' }; },
});

test('registry lists and reports availability', async () => {
  const r = createRegistry([fake('pi'), fake('cc', false)]);
  assert.deepEqual(await r.status(), [
    { id: 'pi', available: true },
    { id: 'cc', available: false },
  ]);
});

test('registry picks preferred adapter when available', async () => {
  const r = createRegistry([fake('pi'), fake('cc')]);
  assert.equal((await r.pick(['cc', 'pi'])).id, 'cc');
  assert.equal((await r.pick(['pi'])).id, 'pi');
});

test('registry falls back to pi when preferred unavailable', async () => {
  const r = createRegistry([fake('pi'), fake('cc', false)]);
  assert.equal((await r.pick(['cc', 'pi'])).id, 'pi');
});

test('registry throws when nothing can serve', async () => {
  const r = createRegistry([fake('cc', false)]);
  await assert.rejects(() => r.pick(['cc']), /no available adapter/);
});
