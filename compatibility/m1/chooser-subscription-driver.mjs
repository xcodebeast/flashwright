#!/usr/bin/env node
// The caller explicitly releases interception acknowledgements to test page readiness ordering.
import { requiredCapabilities } from '../../packages/flashwright-core/dist/commonjs/client.js';
import { residentRuntimeSha256 } from '../../packages/flashwright-core/dist/commonjs/runtime-version.cjs';
let incoming = Buffer.alloc(0);
const accepted = [];
const controls = [];
function reply(message) {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32LE(body.length); body.copy(frame, 4); process.stdout.write(frame);
}
function result(message, value = null) { reply({ kind: 'result', requestId: message.requestId, value, inputDelivery: 'notDispatched' }); }
process.stdin.on('data', chunk => {
  incoming = Buffer.concat([incoming, chunk]);
  while (incoming.length >= 4 && incoming.length >= incoming.readUInt32LE(0) + 4) {
    const length = incoming.readUInt32LE(0);
    const message = JSON.parse(incoming.subarray(4, length + 4));
    incoming = incoming.subarray(length + 4);
    if (message.kind === 'handshake') reply({ kind: 'handshake', handshake: message.handshake, capabilities: requiredCapabilities, residentRuntimeSha256 });
    else if (message.kind === 'command') {
      if (message.method === 'page.fileChooser.subscribe') { accepted.push(['control', message.parameters.page, message.parameters.enabled]); controls.push(message); }
      else if (message.method === 'probe.accepted') result(message, accepted);
      else if (message.method === 'probe.release') { const control = controls.shift(); if (!control) throw Error('No pending control'); accepted.push(['ack', control.parameters.page, control.parameters.enabled]); result(control); result(message); }
      else { accepted.push([message.method, message.parameters.page, message.parameters.label]); result(message); }
    }
  }
});
