#!/usr/bin/env node
// A deliberately faulty protocol peer for public client framing/cancellation tests.
import { requiredCapabilities } from '../../packages/flashwright-core/dist/commonjs/client.js';
import { residentRuntimeSha256 } from '../../packages/flashwright-core/dist/commonjs/runtime-version.cjs';

function frame(body) {
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  const bytes = Buffer.concat([header, body]);
  process.stdout.write(bytes.subarray(0, 1));
  process.stdout.write(bytes.subarray(1, 7));
  process.stdout.write(bytes.subarray(7));
}
function message(value) { frame(Buffer.from(JSON.stringify(value))); }
function data(identifier, offset, payload) {
  const body = Buffer.alloc(13 + payload.length);
  body.writeBigUInt64LE(BigInt(identifier), 1); body.writeUInt32LE(offset, 9); payload.copy(body, 13); frame(body);
}
process.stdout.on('error', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
let incoming = Buffer.alloc(0);
let starts = 0;
let cancellations = 0;
const collectionAttempts = [];
process.stdin.on('data', bytes => {
  incoming = Buffer.concat([incoming, bytes]);
  while (incoming.length >= 4 && incoming.length >= incoming.readUInt32LE(0) + 4) {
    const length = incoming.readUInt32LE(0);
    const request = JSON.parse(incoming.subarray(4, length + 4)); incoming = incoming.subarray(length + 4);
    if (request.kind === 'handshake') {
      message({ kind: 'handshake', handshake: request.handshake, residentRuntimeSha256, capabilities: requiredCapabilities }); continue;
    }
    if (request.kind === 'cancel') {
      cancellations++;
      message({ kind: 'error', requestId: request.requestId, error: { code: 'CancelledError', method: 'probe', message: 'cancelled', inputDelivery: 'notDispatched' } }); continue;
    }
    if (request.method === 'control') {
      message({ kind: 'result', requestId: request.requestId, value: 42 }); continue;
    }
    if (request.method === 'observations') { message({ kind: 'result', requestId: request.requestId, value: { starts, cancellations } }); continue; }
    if (request.method === 'collection.observations') { message({ kind: 'result', requestId: request.requestId, value: collectionAttempts }); continue; }
    const { encoding = 'raw', scenario } = request.parameters;
    if (request.method.startsWith('context.trace.')) collectionAttempts.push({ method: request.method, parameters: request.parameters, timeoutMilliseconds: request.timeoutMilliseconds });
    if (scenario === 'always-busy' || scenario === 'busy-then-transfer' && collectionAttempts.length <= 2) {
      message({ kind: 'result', requestId: request.requestId, value: null }); continue;
    }
    if (scenario === 'collection-error') {
      message({ kind: 'error', requestId: request.requestId, error: { code: 'ResourceLimitError', method: request.method, message: 'original byte limit' } }); continue;
    }
    if (scenario === 'json') { frame(Buffer.from('{invalid')); continue; }
    if (scenario === 'large') {
      const byteLength = 9 * 1024 * 1024;
      message({ kind: 'binaryStart', requestId: request.requestId, encoding: 'raw', byteLength, encodedLength: byteLength });
      const block = Buffer.alloc(64 * 1024, 0xa5);
      for (let offset = 0; offset < byteLength; offset += block.length) data(request.requestId, offset, block);
      message({ kind: 'binaryResult', requestId: request.requestId, byteLength, inputDelivery: 'notDispatched' });
      continue;
    }
    const payload = scenario === 'empty-control-result' ? Buffer.alloc(0) : Buffer.from([0, 128, 255, 1, 2]);
    const encoded = encoding === 'base64' ? Buffer.from(payload.toString('base64')) : payload;
    const start = { kind: 'binaryStart', requestId: request.requestId, encoding, byteLength: scenario === 'oversize' ? 33554433 : payload.length, encodedLength: encoded.length };
    message(start);
    starts++;
    if (scenario === 'oversize') continue;
    if (scenario === 'duplicate') { message(start); continue; }
    if (scenario === 'control-result' || scenario === 'empty-control-result') { message({ kind: 'result', requestId: request.requestId, value: null }); continue; }
    data(scenario === 'identity' ? 999 : request.requestId, scenario === 'offset' ? 1 : 0, encoded.subarray(0, 4));
    if (scenario === 'eof') { process.exit(0); }
    if (scenario === 'cancel' || scenario === 'offset' || scenario === 'identity') continue;
    setImmediate(() => {
      data(request.requestId, 4, encoded.subarray(4));
      message({ kind: 'binaryResult', requestId: request.requestId, byteLength: scenario === 'terminal' ? 6 : 5, inputDelivery: 'notDispatched' });
    });
  }
});
