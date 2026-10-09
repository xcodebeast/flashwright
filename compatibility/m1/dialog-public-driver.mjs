#!/usr/bin/env node
// Real public objects use this bounded transport; no browser process is created.
import { requiredCapabilities } from '../../packages/flashwright-core/dist/commonjs/client.js';
import { residentRuntimeSha256 } from '../../packages/flashwright-core/dist/commonjs/runtime-version.cjs';

let incoming = Buffer.alloc(0);
let capacity;
let evaluation;
let dialogSequence = 0;
let peakPending = 0;
const pending = new Set();
const accepted = [];
const subscriptions = new Map();
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}
function result(request, value = null) {
  pending.delete(request.requestId);
  send({ kind: 'result', requestId: request.requestId, value, inputDelivery: 'notDispatched' });
}
process.stdin.on('data', chunk => {
  incoming = Buffer.concat([incoming, chunk]);
  while (incoming.length >= 4 && incoming.length >= incoming.readUInt32LE(0) + 4) {
    const length = incoming.readUInt32LE(0);
    const request = JSON.parse(incoming.subarray(4, length + 4));
    incoming = incoming.subarray(length + 4);
    if (request.kind === 'handshake') {
      capacity = Number(process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY);
      request.handshake.limits.pendingOperations = capacity;
      send({ kind: 'handshake', handshake: request.handshake, capabilities: requiredCapabilities, residentRuntimeSha256 });
      continue;
    }
    if (request.kind !== 'command') continue;
    if (pending.size >= capacity) {
      send({ kind: 'error', requestId: request.requestId, error: { code: 'ResourceLimitError', method: request.method, message: 'Controlled driver total capacity exhausted' } });
      continue;
    }
    pending.add(request.requestId); peakPending = Math.max(peakPending, pending.size);
    accepted.push({ method: request.method, enabled: request.parameters.enabled });
    if (request.method.endsWith('.dialog.subscribe')) {
      subscriptions.set(request.parameters.page ?? request.parameters.context, request.parameters.enabled);
      result(request);
      send({ kind: 'event', target: 'probe', event: 'subscription', parameters: { accepted: accepted.length } });
    } else if (request.method === 'page.evaluate') {
      if (subscriptions.get('page') || subscriptions.get('context')) {
        evaluation = request;
        send({ kind: 'event', target: 'page', event: 'dialog', parameters: { page: 'page', dialog: `dialog-${++dialogSequence}`, dialogJson: JSON.stringify({ frameId: 'frame', type: 'confirm', message: 'controlled modal', defaultPrompt: '' }) } });
      } else result(request, { kind: 'boolean', value: false });
    } else if (request.method === 'dialog.accept' || request.method === 'dialog.dismiss') {
      result(request);
      if (evaluation) { result(evaluation, { kind: 'boolean', value: request.method === 'dialog.accept' }); evaluation = undefined; }
    } else if (request.method === 'probe.observations') result(request, { accepted, peakPending, pending: pending.size - 1 });
    else result(request);
  }
});
