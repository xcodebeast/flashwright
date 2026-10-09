import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttachmentReceiver } from '../packages/flashwright-core/dist/commonjs/attachments.js';
import { EngineClient } from '../packages/flashwright-core/dist/commonjs/client.js';
import { createRuntimeFixture } from './runtime-fixture.mjs';
import { performance } from 'node:perf_hooks';
const fixtureExecutable = createRuntimeFixture('compatibility/m1/attachment-driver.mjs');

test('native collection busy retries preserve identity, expected length and the original deadline', async () => {
  for (const method of ['context.trace.snapshot.take', 'context.trace.network.take']) await clientCase(async client => {
    await client.waitForHandshake();
    const parameters = { scenario: 'busy-then-transfer', capture: 'original', token: 'original' };
    const transfer = client.requestTraceAttachment(method, parameters, 2000, 5);
    parameters.capture = 'successor'; parameters.token = 'successor';
    assert.deepEqual(await transfer, Buffer.from([0, 128, 255, 1, 2]));
    const attempts = await client.request('collection.observations', {});
    assert.equal(attempts.length, 3);
    for (const attempt of attempts) {
      assert.equal(attempt.method, method);
      assert.equal(attempt.parameters.capture, 'original'); assert.equal(attempt.parameters.token, 'original');
      assert(attempt.timeoutMilliseconds > 0 && attempt.timeoutMilliseconds < 2000);
    }
    assert(attempts[2].timeoutMilliseconds < attempts[0].timeoutMilliseconds);
    assert.deepEqual(await client.request('observations', {}), { starts: 1, cancellations: 0 });
  });
});

test('native collection pressure expires one deadline and never retries a terminal resource error', async () => {
  await clientCase(async client => {
    await client.waitForHandshake();
    const started = performance.now();
    await assert.rejects(client.requestTraceAttachment('context.trace.snapshot.take', { scenario: 'always-busy' }, 60, 5), { name: 'TimeoutError' });
    assert(performance.now() - started < 1000);
    const attempts = await client.request('collection.observations', {});
    assert(attempts.length >= 1 && attempts.length <= 8);
    assert.deepEqual(await client.request('observations', {}), { starts: 0, cancellations: 0 });
  });
  await clientCase(async client => {
    await assert.rejects(client.requestTraceAttachment('context.trace.network.take', { scenario: 'collection-error' }, 2000, 5), { name: 'ResourceLimitError' });
    assert.equal((await client.request('collection.observations', {})).length, 1);
    assert.equal(await client.request('control', {}), 42);
  });
});

test('collection cancellation during busy backoff preserves its original reason and prevents another take', async () => {
  await clientCase(async client => {
    await client.waitForHandshake();
    const cancellation = new AbortController(); const original = new Error('original collector retired');
    const request = client.request.bind(client);
    client.request = async (...arguments_) => {
      const result = await request(...arguments_);
      if (arguments_[0] === 'context.trace.snapshot.take') setTimeout(() => cancellation.abort(original), 1);
      return result;
    };
    await assert.rejects(client.requestTraceAttachment('context.trace.snapshot.take', { scenario: 'always-busy' }, 2000, 5, cancellation.signal), error => error === original);
    assert.equal((await request('collection.observations', {})).length, 1);
    assert.equal(await request('control', {}), 42);
  });
});

test('collection null is forbidden after any binary start, including an empty transfer', async () => {
  for (const scenario of ['control-result', 'empty-control-result']) await clientCase(async client => {
    await assert.rejects(client.requestTraceAttachment('context.trace.snapshot.take', { scenario }, 2000, scenario === 'empty-control-result' ? 0 : 5), { name: 'ProtocolError' });
    assert.equal(client.isClosed(), true);
  });
  await clientCase(async client => {
    await assert.rejects(client.requestBinary('probe', { scenario: 'always-busy' }, 2000, 5), { name: 'ProtocolError' });
  });
});

function chunk(identifier, offset, bytes) {
  const frame = Buffer.alloc(13 + bytes.length);
  frame.writeBigUInt64LE(BigInt(identifier), 1);
  frame.writeUInt32LE(offset, 9);
  bytes.copy(frame, 13);
  return frame;
}

test('raw and base64 attachments interleave without exposing partial buffers', () => {
  const receiver = new AttachmentReceiver(1024, 2);
  receiver.begin(1, 'raw', 4, 4, false);
  receiver.begin(2, 'base64', 5, 8, false);
  receiver.receive(chunk(2, 0, Buffer.from('AID/')));
  receiver.receive(chunk(1, 0, Buffer.from([0, 128])));
  receiver.receive(chunk(2, 4, Buffer.from('AQI=')));
  receiver.receive(chunk(1, 2, Buffer.from([255, 1])));
  assert.deepEqual(receiver.finish(1, 4), Buffer.from([0, 128, 255, 1]));
  assert.deepEqual(receiver.finish(2, 5), Buffer.from([0, 128, 255, 1, 2]));
  receiver.begin(3, 'raw', 0, 0, false);
  assert.deepEqual(receiver.finish(3, 0), Buffer.alloc(0));
});

test('attachment offsets, identities, caps and terminal sizes reject corruption', () => {
  for (const action of [
    receiver => receiver.begin(1, 'raw', 4, 4, false),
    receiver => receiver.begin(2, 'raw', 4, 4, false),
    receiver => receiver.receive(chunk(9, 0, Buffer.from([1]))),
    receiver => receiver.receive(chunk(1, 1, Buffer.from([1]))),
    receiver => receiver.receive(chunk(1, 0, Buffer.alloc(5))),
    receiver => receiver.finish(1, 4),
    receiver => receiver.finish(1, 3),
  ]) {
    const receiver = new AttachmentReceiver(4, 1);
    receiver.begin(1, 'raw', 4, 4, false);
    assert.throws(() => action(receiver), { name: 'ProtocolError' });
  }
  for (const arguments_ of [['raw', 5, 5], ['raw', 4, 5], ['base64', 4, 4], ['unknown', 4, 4], ['raw', -1, -1], ['raw', 1.5, 1.5]]) {
    assert.throws(() => new AttachmentReceiver(4, 1).begin(1, ...arguments_, false), { name: 'ProtocolError' });
  }
});

test('base64 chunks require complete groups and canonical terminal padding', () => {
  for (const invalid of ['AB==', 'AA A', 'A=AA', 'AA-_', 'AA\nA', 'A===', '====', 'AA\u0080A']) {
    const receiver = new AttachmentReceiver(16, 1);
    receiver.begin(1, 'base64', 1, 4, false);
    assert.throws(() => receiver.receive(chunk(1, 0, Buffer.from(invalid, 'latin1'))), { name: 'ProtocolError' });
  }
  const receiver = new AttachmentReceiver(16, 1);
  receiver.begin(1, 'base64', 5, 8, false);
  assert.throws(() => receiver.receive(chunk(1, 0, Buffer.from('AA=='))), { name: 'ProtocolError' });
});

test('expired attachments release bytes but still validate late chunks', () => {
  const receiver = new AttachmentReceiver(16, 1);
  receiver.begin(1, 'raw', 4, 4, false);
  receiver.receive(chunk(1, 0, Buffer.from([1, 2])));
  receiver.expire(1);
  receiver.receive(chunk(1, 2, Buffer.from([3, 4])));
  assert.equal(receiver.finish(1, 4), undefined);
  receiver.begin(2, 'raw', 4, 4, true);
  receiver.discard(2);
  assert.throws(() => receiver.receive(chunk(2, 0, Buffer.alloc(4))), { name: 'ProtocolError' });
});

async function clientCase(work) {
  const client = new EngineClient(fixtureExecutable);
  client.retain();
  try { await work(client); } finally { await client.release(); }
}

test('client assembles fragmented attachment frames and concurrent replies', async () => {
  await clientCase(async client => {
    const values = await Promise.all(['raw', 'base64'].map(encoding => client.requestBinary('probe', { encoding })));
    for (const value of values) assert.deepEqual(value, Buffer.from([0, 128, 255, 1, 2]));
    assert.equal(await client.request('control', {}), 42);
  });
});

test('an attachment larger than a control frame returns every byte', async () => {
  await clientCase(async client => {
    const result = await client.requestBinary('probe', { scenario: 'large' });
    assert.deepEqual(result, Buffer.alloc(9 * 1024 * 1024, 0xa5));
    assert.equal(await client.request('control', {}), 42);
  });
});

test('client rejects malformed starts, chunks, terminal replies and EOF', async () => {
  for (const scenario of ['offset', 'identity', 'oversize', 'duplicate', 'terminal', 'eof', 'control-result', 'json']) {
    await clientCase(async client => {
      await assert.rejects(client.requestBinary('probe', { scenario }), error => {
        assert.ok(['ProtocolError', 'BrowserDisconnectedError'].includes(error.name), `${scenario}: ${error}`);
        return true;
      });
    });
  }
  await clientCase(async client => { await assert.rejects(client.request('probe', {}), { name: 'ProtocolError' }); });
});

test('client deadline discards a partial attachment and leaves its successor usable', async () => {
  await clientCase(async client => {
    assert.equal(await client.request('control', {}), 42);
    await assert.rejects(client.requestBinary('probe', { scenario: 'cancel' }, 250), { name: 'TimeoutError' });
    assert.equal(await client.request('control', {}), 42);
    assert.deepEqual(await client.request('observations', {}), { starts: 1, cancellations: 1 });
  });
});


test('an expected binary length rejects a conflicting start before buffer allocation', async () => {
  await clientCase(async client => {
    assert.equal(await client.request('control', {}), 42);
    let began = false;
    const begin = client.attachments.begin.bind(client.attachments);
    client.attachments.begin = (...arguments_) => { began = true; return begin(...arguments_); };
    await assert.rejects(client.requestBinary('probe', { scenario: 'large' }, 2000, 4), { name: 'ProtocolError' });
    assert.equal(began, false);
  });
  await clientCase(async client => {
    assert.deepEqual(await client.requestBinary('probe', { encoding: 'base64' }, 2000, 5), Buffer.from([0, 128, 255, 1, 2]));
    assert.equal(await client.request('control', {}), 42);
    await assert.rejects(client.requestBinary('probe', {}, 2000, -1), { name: 'InvalidArgumentError' });
    assert.equal(await client.request('control', {}), 42);
  });
});
