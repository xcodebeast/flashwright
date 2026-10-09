import assert from 'node:assert/strict';
import { createRuntimeFixture } from '../../tools/runtime-fixture.mjs';
import { EngineClient } from '../../packages/flashwright-core/dist/commonjs/client.js';

const executable = createRuntimeFixture('compatibility/m1/request-order-driver.mjs');
async function scenario(delay, run) {
  const previous = process.env.FLASHWRIGHT_TEST_HANDSHAKE_DELAY;
  process.env.FLASHWRIGHT_TEST_HANDSHAKE_DELAY = String(delay);
  const client = new EngineClient(executable); client.retain();
  if (previous === undefined) delete process.env.FLASHWRIGHT_TEST_HANDSHAKE_DELAY;
  else process.env.FLASHWRIGHT_TEST_HANDSHAKE_DELAY = previous;
  try { await run(client); } finally { await client.release(); }
}
for (const pendingHandshake of [false, true]) {
  await scenario(pendingHandshake ? 60 : 0, async client => {
    if (!pendingHandshake) await client.waitForHandshake();
    const requests = [1000, 0, 1000, 0].map((timeout, index) => client.request('probe.order', { label: index }, timeout));
    await Promise.all(requests);
    assert.deepEqual(await client.request('probe.accepted', {}), [0, 1, 2, 3]);
  });
}
await scenario(60, async client => {
  const first = client.request('probe.order', { label: 'before readiness' }, 1000);
  const atReadiness = client.waitForHandshake().then(() => client.request('probe.order', { label: 'readiness callback' }, 0));
  await Promise.all([first, atReadiness]);
  assert.deepEqual(await client.request('probe.accepted', {}), ['before readiness', 'readiness callback']);
});
await scenario(200, async client => {
  const expired = assert.rejects(client.request('probe.order', { label: 'expired' }, 20), error => error.name === 'TimeoutError');
  const survivor = client.request('probe.order', { label: 'survivor' }, 0);
  await Promise.all([expired, survivor]);
  assert.deepEqual(await client.request('probe.accepted', {}), ['survivor']);
});
console.log('Ready and pending-handshake request order, callback boundary and expiry before dispatch passed.');
