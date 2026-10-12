import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const clientFilename = new URL('../packages/flashwright-core/dist/commonjs/client.js', import.meta.url);
const require = createRequire(clientFilename);
const { Browser } = require('./index.js');
const { requiredCapabilities } = require('./engine-contract.js');
const { residentRuntimeSha256 } = require('./runtime-version.cjs');

/** Control event/reply order at the actual framed transport boundary, without a production test seam. */
async function fixture() {
  const child = new EventEmitter();
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const liveness = new PassThrough();
  const commands = [];
  const inputEnds = [];
  let incoming = Buffer.alloc(0);
  let closed = false;
  let ended = false;
  let killed = false;
  let holdInput = false;
  let releaseInput;
  function close(signal = null) {
    if (closed) return;
    closed = true;
    releaseInput?.();
    child.emit('exit', signal ? null : 0, signal);
    child.emit('close', signal ? null : 0, signal);
  }
  function reply(message) {
    if (closed) return;
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    stdout.write(Buffer.concat([header, body]));
  }
  const stdin = new Writable({
    write(bytes, encoding, complete) {
      incoming = Buffer.concat([incoming, bytes]);
      let withheld = false;
      while (incoming.length >= 4 && incoming.length >= incoming.readUInt32LE(0) + 4) {
        const length = incoming.readUInt32LE(0);
        const body = incoming.subarray(4, length + 4);
        incoming = incoming.subarray(length + 4);
        if (body[0] === 0) {
          if (holdInput) {
            holdInput = false;
            withheld = true;
            releaseInput = complete;
            events.emit('input');
          }
          continue;
        }
        const message = JSON.parse(body);
        if (message.kind === 'handshake') {
          queueMicrotask(() => reply({ kind: 'handshake', handshake: message.handshake, capabilities: requiredCapabilities, residentRuntimeSha256 }));
        } else if (message.kind === 'command') {
          commands.push(message);
          events.emit('command', message);
        } else if (message.kind === 'inputEnd') {
          inputEnds.push(message);
        } else assert.equal(message.kind, 'cancel');
      }
      if (!withheld) complete();
    },
    final(complete) {
      ended = true;
      complete();
      queueMicrotask(() => close());
    },
  });
  Object.assign(child, { stdin, stdout, stderr, stdio: [stdin, stdout, stderr, liveness] });
  child.kill = signal => { killed = true; close(signal); return true; };
  const module = { exports: {} };
  vm.runInNewContext(await readFile(clientFilename, 'utf8'), {
    module, exports: module.exports,
    require: name => name === 'node:child_process' ? { spawn: () => child } : require(name),
    process, Buffer, Error, Promise, Map, Set, AbortController,
    setTimeout, clearTimeout, setImmediate, queueMicrotask,
  }, { filename: clientFilename.pathname });
  const client = new module.exports.EngineClient('controlled-shutdown-peer');
  client.retain();
  await client.waitForHandshake();
  return {
    client, commands, inputEnds, close, reply,
    get ended() { return ended; },
    get killed() { return killed; },
    nextCommand: () => once(events, 'command').then(([message]) => message),
    holdNextInput() { holdInput = true; return once(events, 'input'); },
    releaseInput: () => releaseInput?.(),
    disconnect: identifier => reply({ kind: 'event', target: identifier, event: 'disconnected', parameters: null }),
    result: (command, value = null) => reply({ kind: 'result', requestId: command.requestId, value }),
    error: command => reply({ kind: 'error', requestId: command.requestId, error: {
      code: 'ProtocolError', method: command.method, message: 'original native transport failure',
      inputDelivery: 'uncertain', diagnostics: { nativeCause: 'retained' },
    } }),
  };
}

function assertOriginalError(error) {
  assert.equal(error.name, 'ProtocolError');
  assert.match(error.message, /original native transport failure/);
  assert.doesNotMatch(error.message, /driver exited/);
  assert.equal(error.details.inputDelivery, 'uncertain');
  assert.deepEqual(Object.keys(error.details.diagnostics), ['nativeCause']);
  assert.equal(error.details.diagnostics.nativeCause, 'retained');
}

test('last browser disconnect preserves a terminal reply arriving after its event', async () => {
  const peer = await fixture();
  try {
    const browser = new Browser(peer.client, 'browser', 'controlled');
    const accepted = peer.nextCommand();
    const operation = peer.client.request('page.evaluate', {}).catch(error => error);
    const command = await accepted;
    peer.disconnect('browser');
    await nextTurn();
    peer.error(command);
    assertOriginalError(await operation);
    await browser.close();
    assert.equal(peer.ended, true);
    assert.equal(peer.killed, false);
  } finally { peer.close(); }
});

test('explicit final browser close drains earlier operation replies', async () => {
  const peer = await fixture();
  try {
    const browser = new Browser(peer.client, 'browser', 'controlled');
    const accepted = peer.nextCommand();
    const operation = peer.client.request('page.evaluate', {}).catch(error => error);
    const command = await accepted;
    const closingAccepted = peer.nextCommand();
    const closing = browser.close();
    peer.result(await closingAccepted);
    await nextTurn();
    peer.error(command);
    assertOriginalError(await operation);
    await closing;
    assert.equal(peer.ended, true);
    assert.equal(peer.killed, false);
  } finally { peer.close(); }
});

test('another retained browser remains usable after a sibling disconnect', async () => {
  const peer = await fixture();
  try {
    const first = new Browser(peer.client, 'first', 'controlled');
    peer.client.retain();
    const second = new Browser(peer.client, 'second', 'controlled');
    peer.disconnect('first');
    await nextTurn();
    await first.close();
    assert.equal(peer.client.isClosed(), false);
    const accepted = peer.nextCommand();
    const operation = peer.client.request('page.evaluate', {});
    peer.result(await accepted, 'surviving browser');
    assert.equal(await operation, 'surviving browser');
    const closingAccepted = peer.nextCommand();
    const closing = second.close();
    peer.result(await closingAccepted);
    await closing;
    assert.equal(peer.killed, false);
  } finally { peer.close(); }
});

test('final release waits for every reply and refuses new commands', async () => {
  const peer = await fixture();
  try {
    const firstAccepted = peer.nextCommand();
    const first = peer.client.request('page.evaluate', {});
    const firstCommand = await firstAccepted;
    const secondAccepted = peer.nextCommand();
    const second = peer.client.request('page.evaluate', {});
    const secondCommand = await secondAccepted;
    const closing = peer.client.release();
    await assert.rejects(peer.client.request('page.evaluate', {}), /engine client is closed/);
    peer.result(secondCommand, 2);
    assert.equal(await second, 2);
    assert.equal(peer.ended, false);
    peer.result(firstCommand, 1);
    assert.equal(await first, 1);
    await closing;
    assert.equal(peer.commands.length, 2);
    assert.equal(peer.ended, true);
  } finally { peer.close(); }
});

test('final release retains an unfinished input stream after its error reply', async () => {
  const peer = await fixture();
  try {
    const input = peer.holdNextInput();
    const accepted = peer.nextCommand();
    const operation = peer.client.requestWithInput('upload', {}, [Buffer.alloc(1024 * 1024)]).catch(error => error);
    const command = await accepted;
    await input;
    peer.error(command);
    const closing = peer.client.release();
    await nextTurn();
    assert.equal(peer.ended, false);
    peer.releaseInput();
    assertOriginalError(await operation);
    await closing;
    assert.deepEqual(peer.inputEnds, [{ kind: 'inputEnd', requestId: command.requestId, aborted: true }]);
    assert.equal(peer.killed, false);
  } finally { peer.close(); }
});

test('an unresponsive final operation remains bounded by the shutdown budget', async () => {
  const peer = await fixture();
  try {
    const accepted = peer.nextCommand();
    const operation = peer.client.request('page.evaluate', {}).catch(error => error);
    await accepted;
    const started = performance.now();
    await peer.client.release();
    const error = await operation;
    assert.equal(error.name, 'BrowserDisconnectedError');
    assert.equal(peer.killed, true);
    assert.ok(performance.now() - started < 5000);
  } finally { peer.close(); }
});
