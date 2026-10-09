#!/usr/bin/env node
// Fake transport records acceptance order without creating any browser process.
import { requiredCapabilities } from '../../packages/flashwright-core/dist/commonjs/client.js';
import { residentRuntimeSha256 } from '../../packages/flashwright-core/dist/commonjs/runtime-version.cjs';

let incoming = Buffer.alloc(0);
const accepted = [];
function reply(message) {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32LE(body.length); body.copy(frame, 4); process.stdout.write(frame);
}
process.stdin.on('data', chunk => {
  incoming = Buffer.concat([incoming, chunk]);
  while (incoming.length >= 4 && incoming.length >= incoming.readUInt32LE(0) + 4) {
    const length = incoming.readUInt32LE(0);
    const message = JSON.parse(incoming.subarray(4, length + 4));
    incoming = incoming.subarray(length + 4);
    if (message.kind === 'handshake') {
      setTimeout(() => reply({ kind: 'handshake', handshake: message.handshake, capabilities: requiredCapabilities, residentRuntimeSha256 }), Number(process.env.FLASHWRIGHT_TEST_HANDSHAKE_DELAY ?? 0));
    } else if (message.kind === 'command') {
      if (message.method !== 'probe.accepted') accepted.push(message.parameters.label);
      reply({ kind: 'result', requestId: message.requestId, value: [...accepted], inputDelivery: 'notDispatched' });
    }
  }
});
