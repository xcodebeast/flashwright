#!/usr/bin/env node
// Controlled host transport: held requests complete only when a recovery request releases them.
import { requiredCapabilities } from '../../packages/flashwright-core/dist/commonjs/client.js';
import { residentRuntimeSha256 } from '../../packages/flashwright-core/dist/commonjs/runtime-version.cjs';

let incoming = Buffer.alloc(0);
const held = [];
const accepted = [];
function reply(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}
function result(message) { reply({ kind: 'result', requestId: message.requestId, value: [...accepted], inputDelivery: 'notDispatched' }); }
process.stdin.on('data', chunk => {
  incoming = Buffer.concat([incoming, chunk]);
  while (incoming.length >= 4 && incoming.length >= incoming.readUInt32LE(0) + 4) {
    const length = incoming.readUInt32LE(0);
    const message = JSON.parse(incoming.subarray(4, length + 4));
    incoming = incoming.subarray(length + 4);
    if (message.kind === 'handshake') {
      message.handshake.limits.pendingOperations = Number(process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY);
      reply({ kind: 'handshake', handshake: message.handshake, capabilities: requiredCapabilities, residentRuntimeSha256 });
    } else if (message.kind === 'command') {
      accepted.push(message.method);
      if (message.parameters.releaseAfter) setTimeout(() => result(message), message.parameters.releaseAfter);
      else if (message.parameters.hold || message.method === 'page.fileChooser.subscribe') held.push(message);
      else {
        if (message.parameters.flush) for (const pending of held.splice(0)) result(pending);
        if (message.parameters.holdReply) held.push(message);
        else result(message);
      }
    }
  }
});
