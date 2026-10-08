import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { EngineClient } from '../../packages/flashwright/dist/commonjs/client.js';

const allocationMethods = ['browser.launch', 'browser.newContext', 'context.newPage'];
const handleMethods = ['page.evaluateHandle', 'frame.evaluateHandle', 'handle.evaluateHandle', 'handle.getProperty', 'handle.getProperties'];
const deliveryScenarios = [
  ['locator.acknowledged', { inputDelivery: 'acknowledged' }],
  ['locator.notDispatched', { inputDelivery: 'notDispatched' }],
  ['locator.error', { error: true }],
];
const assertionScenarios = [['assertion.result', false], ['assertion.error', true]];
const selectedScenario = process.argv[2];
const scenarioNames = [...allocationMethods, ...handleMethods, ...deliveryScenarios.map(([name]) => name), ...assertionScenarios.map(([name]) => name), 'handshake.capabilityMismatch'];
assert.ok(selectedScenario === undefined || scenarioNames.includes(selectedScenario), `Unknown deadline scenario: ${selectedScenario}`);
const isSelected = name => selectedScenario === undefined || selectedScenario === name;

for (const method of allocationMethods) {
  if (!isSelected(method)) continue;
  const client = new EngineClient(resolve('compatibility/m1/reply-race-driver.mjs'));
  client.retain();
  try {
    await client.request('probe.ready', {});
    await assert.rejects(client.request(method, {}, 200), error => error.name === 'TimeoutError' && error.details.cleanup === 'resourceDisposedAfterLateSuccess');
  } finally { await client.release(); }
}
for (const method of handleMethods) {
  if (!isSelected(method)) continue;
  const client = new EngineClient(resolve('compatibility/m1/reply-race-driver.mjs'));
  client.retain();
  try {
    await client.request('probe.ready', {});
    await assert.rejects(client.request(method, {}, 200), error => error.name === 'TimeoutError' && error.details.cleanup === 'handleGroupDisposedAfterLateSuccess');
  } finally { await client.release(); }
}
for (const [name, parameters] of deliveryScenarios) {
  if (!isSelected(name)) continue;
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
for (const [name, error] of assertionScenarios) {
  if (!isSelected(name)) continue;
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
if (isSelected('handshake.capabilityMismatch')) {
  process.env.FLASHWRIGHT_TEST_OMIT_CAPABILITY = 'keyboard.press';
  const incompatible = new EngineClient(resolve('compatibility/m1/reply-race-driver.mjs'));
  delete process.env.FLASHWRIGHT_TEST_OMIT_CAPABILITY;
  incompatible.retain();
  try { await assert.rejects(incompatible.request('browser.launch', {}), error => error.name === 'ProtocolError' && error.message.includes('mismatch')); }
  finally { await incompatible.release(); }
}
console.log(`Deadline scenario ${selectedScenario ?? 'all'} preserved ownership cleanup and terminal diagnostics.`);
