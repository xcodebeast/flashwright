import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { EngineClient } from '../../packages/flashwright/dist/commonjs/client.js';

for (const method of ['browser.launch', 'browser.newContext', 'context.newPage']) {
  const client = new EngineClient(resolve('compatibility/m1/reply-race-driver.mjs'));
  client.retain();
  try {
    await client.request('probe.ready', {});
    await assert.rejects(client.request(method, {}, 200), error => error.name === 'TimeoutError' && error.details.cleanup === 'resourceDisposedAfterLateSuccess');
  } finally { await client.release(); }
}
for (const parameters of [{ inputDelivery: 'acknowledged' }, { inputDelivery: 'notDispatched' }, { error: true }]) {
  const client = new EngineClient(resolve('compatibility/m1/reply-race-driver.mjs'));
  client.retain();
  try {
    await client.request('probe.ready', {});
    await assert.rejects(client.request('locator.run', parameters, 200), error => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.details.inputDelivery, parameters.inputDelivery ?? 'acknowledged');
      assert.match(error.stack, /Called from:/);
      if (parameters.error) {
        assert.equal(error.details.method, 'locator.click');
        assert.ok(error.message.endsWith('\uD800\0\uDC00'));
      }
      return true;
    });
  } finally { await client.release(); }
}
for (const error of [false, true]) {
  const client = new EngineClient(resolve('compatibility/m1/reply-race-driver.mjs'));
  client.retain();
  const observation = { status: 'observation', matches: true, received: { kind: 'string', units: [0xD800, 0, 0xDC00] }, diagnosticTruncated: false };
  try {
    await client.request('probe.ready', {});
    await assert.rejects(client.request('assertion.run', { error, observation }, 200), failure => {
      assert.equal(failure.name, 'TimeoutError');
      assert.equal(failure.details.inputDelivery, 'notDispatched');
      assert.deepEqual(failure.details.diagnostics, observation);
      return true;
    });
  } finally { await client.release(); }
}
process.env.FLASHWRIGHT_TEST_OMIT_CAPABILITY = 'keyboard.press';
const incompatible = new EngineClient(resolve('compatibility/m1/reply-race-driver.mjs'));
delete process.env.FLASHWRIGHT_TEST_OMIT_CAPABILITY;
incompatible.retain();
try { await assert.rejects(incompatible.request('browser.launch', {}), error => error.name === 'ProtocolError' && error.message.includes('mismatch')); }
finally { await incompatible.release(); }
console.log('Late replies preserve ownership cleanup, input delivery and UTF-16 diagnostics.');
