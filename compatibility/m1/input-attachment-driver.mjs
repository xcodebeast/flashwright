// A bounded protocol peer observes actual host input bytes, cancellation and interleaved controls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { requiredCapabilities } from '../../packages/flashwright-core/dist/commonjs/client.js';
import { residentRuntimeSha256 } from '../../packages/flashwright-core/dist/commonjs/runtime-version.cjs';

let incoming = Buffer.alloc(0);
let paused = false;
const inputs = new Map();
const completed = [];
const controls = [];
let cancellations = 0;
let starts = 0;
function message(value) {
  const body = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length); body.copy(frame, 4);
  process.stdout.write(frame);
}
function result(requestId, value) { message({ kind: 'result', requestId, value, inputDelivery: 'notDispatched' }); }
function reject(requestId, code) { message({ kind: 'error', requestId, error: { code, method: 'upload', message: code, inputDelivery: 'notDispatched' } }); }
function consume() {
  while (!paused && incoming.length >= 4 && incoming.length >= incoming.readUInt32LE(0) + 4) {
    const length = incoming.readUInt32LE(0);
    const body = incoming.subarray(4, length + 4); incoming = incoming.subarray(length + 4);
    if (body[0] === 0) {
      assert.ok(body.length > 13 && body.length <= 65549);
      const identifier = Number(body.readBigUInt64LE(1));
      const input = inputs.get(identifier); assert.ok(input);
      assert.equal(body.readUInt32LE(9), input.received);
      input.received += body.length - 13; input.chunks++;
      assert.ok(input.received <= input.expected);
      input.hash.update(body.subarray(13));
      if (input.chunks === 1) {
        message({ kind: 'event', target: 'input-probe', event: 'first-chunk', parameters: identifier });
        if (input.scenario === 'pause') {
          paused = true; process.stdin.pause();
          setTimeout(() => { paused = false; consume(); process.stdin.resume(); }, 150);
        }
      }
      continue;
    }
    const request = JSON.parse(body);
    if (request.kind === 'handshake') {
      if (process.env.FLASHWRIGHT_INPUT_TEST_SMALL_FRAMES) request.handshake.limits.controlFrameBytes = 1024;
      message({ kind: 'handshake', handshake: request.handshake, residentRuntimeSha256, capabilities: requiredCapabilities }); continue;
    }
    if (request.kind === 'cancel') {
      cancellations++;
      const input = inputs.get(request.requestId); assert.ok(input);
      if (!input.rejected) { input.rejected = true; reject(request.requestId, 'CancelledError'); }
      continue;
    }
    if (request.kind === 'inputEnd') {
      const input = inputs.get(request.requestId); assert.ok(input);
      if (!request.aborted) assert.equal(input.received, input.expected);
      const observation = { received: input.received, chunks: input.chunks, aborted: request.aborted, sha256: input.hash.digest('hex') };
      completed.push(observation);
      if (input.scenario === 'hold' && !input.rejected) {
        input.value = observation;
        message({ kind: 'event', target: 'input-probe', event: 'held', parameters: request.requestId });
      } else {
        inputs.delete(request.requestId);
        if (!input.rejected) result(request.requestId, observation);
      }
      continue;
    }
    if (request.method === 'observations') { result(request.requestId, { completed, controls, starts, cancellations }); continue; }
    if (request.method === 'control') {
      controls.push([...inputs.values()].map(input => ({ received: input.received, expected: input.expected })));
      result(request.requestId, 42); continue;
    }
    if (request.method === 'release') {
      for (const [identifier, input] of inputs) if (input.value) { result(identifier, input.value); inputs.delete(identifier); }
      result(request.requestId, true); continue;
    }
    starts++;
    inputs.set(request.requestId, { expected: request.inputByteLength, received: 0, chunks: 0, hash: createHash('sha256'), scenario: request.parameters.scenario });
    if (request.parameters.scenario === 'reject') { inputs.get(request.requestId).rejected = true; reject(request.requestId, 'InvalidArgumentError'); }
    if (request.parameters.scenario === 'stuck') {
      paused = true; process.stdin.pause();
      // A paused stdin does not keep Bun alive; retain the intended unresponsive peer.
      setInterval(() => {}, 1000);
    }
  }
}
process.stdout.on('error', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', bytes => { incoming = Buffer.concat([incoming, bytes]); consume(); });
