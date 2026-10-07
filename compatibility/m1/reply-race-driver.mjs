#!/usr/bin/env node
// Deterministic peer: withhold terminal replies until the caller cancels the operation.
import assert from 'node:assert/strict';
import { requiredCapabilities } from '../../packages/flashwright/dist/commonjs/client.js';
import { residentRuntimeSha256 } from '../../packages/flashwright/dist/commonjs/runtime-version.cjs';

let incoming = Buffer.alloc(0);
let allocation;
let completed = false;
function reply(message) {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32LE(body.length);
  body.copy(frame, 4);
  process.stdout.write(frame);
}
process.stdin.on('data', chunk => {
  incoming = Buffer.concat([incoming, chunk]);
  while (incoming.length >= 4 && incoming.length >= 4 + incoming.readUInt32LE(0)) {
    const length = incoming.readUInt32LE(0);
    const message = JSON.parse(incoming.subarray(4, length + 4));
    incoming = incoming.subarray(length + 4);
    if (message.kind === 'handshake') {
      reply({ kind: 'handshake', handshake: message.handshake, capabilities: requiredCapabilities.filter(method => method !== process.env.FLASHWRIGHT_TEST_OMIT_CAPABILITY), residentRuntimeSha256 });
    } else if (message.method === 'probe.ready') {
      reply({ kind: 'result', requestId: message.requestId, value: null, inputDelivery: 'notDispatched' });
    } else if (message.kind === 'cancel') {
      assert.equal(message.requestId, allocation.requestId);
      if (allocation.method === 'assertion.run') {
        completed = true;
        const diagnostics = allocation.parameters.observation;
        if (allocation.parameters.error) reply({ kind: 'error', requestId: allocation.requestId, error: { code: 'CancelledError', method: allocation.method, message: 'cancelled assertion', diagnostics, inputDelivery: 'notDispatched' } });
        else reply({ kind: 'result', requestId: allocation.requestId, value: diagnostics, inputDelivery: 'notDispatched' });
      } else if (allocation.method === 'locator.run') {
        completed = true;
        if (allocation.parameters.error) {
          reply({ kind: 'error', requestId: allocation.requestId, error: { code: 'CancelledError', method: 'locator.click', message: 'lossy fallback', messageUtf16: [0xD800, 0, 0xDC00], inputDelivery: 'acknowledged' } });
        } else {
          reply({ kind: 'result', requestId: allocation.requestId, value: null, inputDelivery: allocation.parameters.inputDelivery });
        }
      } else {
        reply({ kind: 'result', requestId: allocation.requestId, value: { identifier: 'late-allocation' }, inputDelivery: 'notDispatched' });
      }
    } else if (!allocation) {
      allocation = message;
    } else {
      const expected = {
        'browser.launch': ['browser.close', 'browser'],
        'browser.newContext': ['context.close', 'context'],
        'context.newPage': ['page.close', 'page'],
      }[allocation.method];
      assert.equal(message.method, expected[0]);
      assert.equal(message.parameters[expected[1]], 'late-allocation');
      completed = true;
      reply({ kind: 'result', requestId: message.requestId, value: null, inputDelivery: 'notDispatched' });
    }
  }
});
process.stdin.on('end', () => { if (process.env.FLASHWRIGHT_TEST_OMIT_CAPABILITY) assert.equal(allocation, undefined); else assert.ok(completed); });
