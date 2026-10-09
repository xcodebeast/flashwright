import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { EngineClient } from '../packages/flashwright-core/dist/commonjs/client.js';
import { createRuntimeFixture } from './runtime-fixture.mjs';
const executable = createRuntimeFixture('compatibility/m1/input-attachment-driver.mjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function clientCase(callback, smallFrames = false) {
  const previous = process.env.FLASHWRIGHT_INPUT_TEST_SMALL_FRAMES;
  if (smallFrames) process.env.FLASHWRIGHT_INPUT_TEST_SMALL_FRAMES = '1';
  const client = new EngineClient(executable); client.retain();
  if (previous === undefined) delete process.env.FLASHWRIGHT_INPUT_TEST_SMALL_FRAMES;
  else process.env.FLASHWRIGHT_INPUT_TEST_SMALL_FRAMES = previous;
  try { await client.waitForHandshake(); await callback(client); } finally { await client.release(); }
}
function nextEvent(client, event) {
  return new Promise(resolve => { client.subscribeObject('input-probe', value => { if (value.event === event) resolve(value.parameters); }); });
}

test('raw input above control-frame size preserves bytes and interleaves ordinary controls', async () => {
  await clientCase(async client => {
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0xa5);
    const first = nextEvent(client, 'first-chunk');
    const upload = client.requestWithInput('upload', {}, [bytes], 10000);
    await first;
    assert.equal(await client.request('control', {}), 42);
    const result = await upload;
    assert.equal(result.sha256, digest(bytes)); assert.equal(result.received, bytes.length);
    assert.ok(result.chunks >= 160); assert.equal(result.aborted, false);
    const observations = await client.request('observations', {});
    assert.ok(observations.controls[0].some(input => input.received < input.expected));
  });
});

test('input snapshot and empty payloads preserve ownership under tiny negotiated frames', async () => {
  await clientCase(async client => {
    const bytes = Buffer.alloc(128 * 1024, 0x53); const expected = digest(bytes);
    const first = nextEvent(client, 'first-chunk');
    const upload = client.requestWithInput('upload', {}, [bytes]);
    await first; bytes.fill(0xff);
    assert.equal((await upload).sha256, expected);
    const empty = await client.requestWithInput('upload', {}, []);
    assert.deepEqual(empty, { received: 0, chunks: 0, aborted: false, sha256: digest(Buffer.alloc(0)) });
  }, true);
});

test('header rejection closes the input stream and preserves the original error and successor', async () => {
  await clientCase(async client => {
    await assert.rejects(client.requestWithInput('upload', { scenario: 'reject' }, [Buffer.alloc(8 * 1024 * 1024)]), { name: 'InvalidArgumentError' });
    assert.equal(await client.request('control', {}), 42);
    const observation = await client.request('observations', {});
    assert.equal(observation.completed.length, 1); assert.equal(observation.completed[0].aborted, true);
    assert.equal((await client.requestWithInput('upload', {}, [Buffer.from('successor')])).received, 9);
  });
});

test('a stalled partial input times out, closes its stream and leaves the client usable', async () => {
  await clientCase(async client => {
    await assert.rejects(client.requestWithInput('upload', { scenario: 'pause' }, [Buffer.alloc(16 * 1024 * 1024)], 80), { name: 'TimeoutError' });
    const observation = await client.request('observations', {});
    assert.equal(observation.cancellations, 1); assert.equal(observation.completed[0].aborted, true);
    assert.ok(observation.completed[0].received < 16 * 1024 * 1024);
    assert.equal(await client.request('control', {}), 42);
  });
});

test('input reservation survives completed transfer until the terminal operation outcome', async () => {
  await clientCase(async client => {
    const firstHeld = nextEvent(client, 'held');
    const first = client.requestWithInput('upload', { scenario: 'hold' }, [Buffer.from('one')]); await firstHeld;
    const secondHeld = nextEvent(client, 'held');
    const second = client.requestWithInput('upload', { scenario: 'hold' }, [Buffer.from('two')]); await secondHeld;
    await assert.rejects(client.requestWithInput('upload', {}, []), { name: 'ResourceLimitError' });
    assert.equal((await client.request('observations', {})).starts, 2);
    await client.request('release', {}); await Promise.all([first, second]);
    assert.equal((await client.requestWithInput('upload', {}, [Buffer.from('three')])).received, 5);
  });
});

test('oversized host input rejects before protocol publication', async () => {
  await clientCase(async client => {
    await assert.rejects(client.requestWithInput('upload', {}, [Buffer.alloc(32 * 1024 * 1024 + 1)]), { name: 'ResourceLimitError' });
    assert.equal((await client.request('observations', {})).starts, 0);
  });
});

test('an unresponsive input pipe retains an independent caller deadline and bounded cleanup', async () => {
  await clientCase(async client => {
    const started = performance.now();
    await assert.rejects(client.requestWithInput('upload', { scenario: 'stuck' }, [Buffer.alloc(16 * 1024 * 1024)], 80), { name: 'TimeoutError' });
    assert.ok(performance.now() - started < 4500);
    assert.equal(client.isClosed(), true);
  });
});
