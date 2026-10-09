import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const { TraceFilmstripChannel, sampleTraceClock } = require('../packages/flashwright-core/dist/commonjs/trace-filmstrip.js');
const { TraceResources } = require('../packages/flashwright-core/dist/commonjs/trace-resources.js');
const { TraceWriter } = require('../packages/flashwright-core/dist/commonjs/trace-writer.js');
const { tryAcquireTraceTransfer } = require('../packages/flashwright-core/dist/commonjs/trace-transfers.js');
const checks = [];
const deferred = () => { let resolve; const promise = new Promise(fulfill => { resolve = fulfill; }); return { promise, resolve }; };
const jpeg = Buffer.from([255, 216, 0, 255, 217]);
const metadata = (token = 1) => ({ token, page: 'page', width: 1001, height: 701, timestamp: 50, frameSwapWallTime: 1700000000000, byteLength: jpeg.length });
const clock = { nativeTime: 100, hostBefore: 109, hostAfter: 111, offset: 10, uncertainty: 1 };
async function check(name, callback) { await callback(); checks.push(name); }
class Driver {
  calls = [];
  frames = new Map();
  bytes = jpeg;
  async request(method, parameters) {
    this.calls.push({ method, parameters });
    if (method.endsWith('.clock')) return { monotonicTime: 10 };
    if (method.endsWith('.pull')) return { generation: parameters.generation, frames: this.frames.get(parameters.context)?.splice(0) ?? [] };
    return null;
  }
  async requestBinary(method, parameters) { this.calls.push({ method, parameters }); return Buffer.from(this.bytes); }
}
async function fixture(driver = new Driver(), context = 'context', generation = 'generation') {
  const resources = await TraceResources.create();
  const writer = await TraceWriter.create(resources);
  const channel = await TraceFilmstripChannel.start(driver, context, generation, clock, resources, writer, page => `trace/${page}`);
  clearTimeout(channel.timer);
  return { driver, resources, writer, channel, async dispose() { channel.ownerClosed(); await channel.stop(); await writer.dispose(); await resources.dispose(); } };
}
function poll(channel) {
  const work = channel.poll();
  channel.polling = work;
  return work.finally(() => { if (channel.polling === work) channel.polling = undefined; });
}
await check('snapshot or network ingestion shares filmstrip capacity through its original context lease', async () => {
  const driver = new Driver();
  const state = await fixture(driver, 'context');
  const releaseSnapshot = tryAcquireTraceTransfer(driver, 'context');
  const releaseNetwork = tryAcquireTraceTransfer(driver, 'other-context');
  try {
    assert.equal(typeof releaseSnapshot, 'function');
    assert.equal(typeof releaseNetwork, 'function');
    driver.frames.set('context', [metadata()]);
    await poll(state.channel);
    assert.equal(driver.calls.filter(call => call.method.endsWith('.take')).length, 0);
    releaseSnapshot();
    await poll(state.channel);
    assert.equal(driver.calls.filter(call => call.method.endsWith('.take')).length, 1);
    const successor = tryAcquireTraceTransfer(driver, 'context');
    assert.equal(typeof successor, 'function');
    releaseSnapshot();
    assert.equal(tryAcquireTraceTransfer(driver, 'context'), undefined);
    assert.equal(tryAcquireTraceTransfer(driver, 'third-context'), undefined);
    successor();
  } finally { releaseSnapshot?.(); releaseNetwork?.(); await state.dispose(); }
});
await check('clock calibration retains a containing interval and performs exactly three bounded requests', async () => {
  const driver = new Driver();
  const before = performance.now();
  const sample = await sampleTraceClock(driver, 'context');
  assert.equal(driver.calls.length, 3);
  assert.ok(sample.hostBefore >= before && sample.hostAfter <= performance.now());
  assert.equal(sample.nativeTime + sample.offset, (sample.hostBefore + sample.hostAfter) / 2);
  assert.equal(sample.uncertainty, (sample.hostAfter - sample.hostBefore) / 2);
  driver.request = async () => ({ monotonicTime: NaN });
  await assert.rejects(sampleTraceClock(driver, 'context'), { name: 'ProtocolError' });
});
await check('delayed collection preserves native capture time and exact resource bytes', async () => {
  const state = await fixture();
  try {
    state.driver.frames.set('context', [metadata()]);
    await poll(state.channel);
    await state.channel.stop();
    await state.writer.writes;
    const events = (await readFile(join(state.writer.directory, 'trace.trace'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.length, 1);
    assert.equal(events[0].timestamp, 60);
    assert.equal(events[0].frameSwapWallTime, 1700000000000);
    assert.equal(events[0].width, 1001);
    assert.equal(events[0].pageId, 'trace/page');
    const [alias, resource] = [...state.writer.aliases][0];
    assert.equal(alias, `resources/${events[0].sha1}`);
    assert.deepEqual(await readFile(resource.path), jpeg);
    assert.equal(state.writer.failure, undefined);
    assert.deepEqual(state.driver.calls.filter(call => call.method.endsWith('.seal') || call.method.endsWith('.dispose')).map(call => call.method.split('.').at(-1)), ['seal', 'dispose']);
  } finally { await state.dispose(); }
});
await check('publication may reveal an older token after a newer page without corrupting capture', async () => {
  const state = await fixture();
  try {
    state.driver.frames.set('context', [metadata(2)]);
    await poll(state.channel);
    state.driver.frames.set('context', [metadata(1)]);
    await poll(state.channel);
    assert.equal(state.writer.failure, undefined);
    assert.equal(state.writer.events, 2);
    assert.equal(state.writer.aliases.size, 1);
  } finally { await state.dispose(); }
});
await check('two engine slots remain held through ingestion and late owner closure', async () => {
  const driver = new Driver();
  const states = await Promise.all(['first', 'second', 'third'].map(context => fixture(driver, context)));
  const entered = [deferred(), deferred()];
  const release = deferred();
  const work = [];
  try {
    for (let index = 0; index < 3; index++) driver.frames.set(['first', 'second', 'third'][index], [metadata()]);
    for (let index = 0; index < 2; index++) {
      const original = states[index].resources.captureBytes.bind(states[index].resources);
      states[index].resources.captureBytes = async (...arguments_) => { entered[index].resolve(); await release.promise; return original(...arguments_); };
      work.push(poll(states[index].channel));
    }
    await Promise.all(entered.map(gate => gate.promise));
    await poll(states[2].channel);
    assert.equal(driver.calls.filter(call => call.method.endsWith('.take')).length, 2);
    states[0].channel.ownerClosed();
    let stopped = false;
    const stopping = states[0].channel.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    await poll(states[2].channel);
    assert.equal(driver.calls.filter(call => call.method.endsWith('.take')).length, 2);
    release.resolve();
    await Promise.all([...work, stopping]);
    await poll(states[2].channel);
    assert.equal(driver.calls.filter(call => call.method.endsWith('.take')).length, 3);
    assert.equal(states[0].writer.events, 0);
    assert.equal(states[2].writer.events, 1);
  } finally { release.resolve(); await Promise.all(work); await Promise.all(states.map(state => state.dispose())); }
});
for (const [name, frames] of [
  ['duplicate token', [metadata(), metadata()]],
  ['too many frames', Array.from({ length: 129 }, (_, index) => metadata(index + 1))],
  ['oversized image', [{ ...metadata(), byteLength: 4 * 1024 * 1024 + 1 }]],
  ['invalid dimensions', [{ ...metadata(), width: NaN }]],
  ['invalid clock', [{ ...metadata(), timestamp: -1 }]],
  ['invalid page identity', [{ ...metadata(), page: 'x'.repeat(65) }]],
]) await check(`${name} fails capture before any binary transfer`, async () => {
  const state = await fixture();
  try {
    state.driver.frames.set('context', frames);
    await poll(state.channel);
    await state.channel.stop();
    assert.equal(state.writer.failure?.name, 'ProtocolError');
    assert.equal(state.driver.calls.filter(call => call.method.endsWith('.take')).length, 0);
    assert.equal(state.driver.calls.filter(call => call.method.endsWith('.dispose')).length, 1);
  } finally { await state.dispose(); }
});
await check('mismatched generations and non-JPEG binary data fail without archiving a partial frame', async () => {
  for (const wrongGeneration of [true, false]) {
    const state = await fixture();
    try {
      state.driver.frames.set('context', [metadata()]);
      if (wrongGeneration) {
        const request = state.driver.request.bind(state.driver);
        state.driver.request = async (method, parameters) => method.endsWith('.pull') ? { generation: 'stale', frames: [metadata()] } : request(method, parameters);
      } else state.driver.bytes = Buffer.alloc(jpeg.length);
      await poll(state.channel);
      await state.channel.stop();
      assert.equal(state.writer.failure?.name, 'ProtocolError');
      assert.equal(state.writer.events, 0);
      assert.equal(state.writer.aliases.size, 0);
    } finally { await state.dispose(); }
  }
});
await check('activity is coalesced while pending and cannot leak after the original chunk seals', async () => {
  const state = await fixture();
  const pending = deferred();
  try {
    const request = state.driver.request.bind(state.driver);
    state.driver.request = async (method, parameters) => { const result = await request(method, parameters); if (method.endsWith('.activity')) await pending.promise; return result; };
    state.channel.activity('page');
    for (let index = 0; index < 1000; index++) state.channel.activity('page');
    assert.equal(state.channel.activityPages.size, 1);
    const stopping = state.channel.stop();
    state.channel.activity('different-page');
    pending.resolve();
    await stopping;
    const calls = state.driver.calls.filter(call => call.method.endsWith('.activity'));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].parameters, { context: 'context', generation: 'generation', page: 'page' });
  } finally { pending.resolve(); await state.dispose(); }
});
await check('an uncertain native start owns disposal and releases its resource lease', async () => {
  const resources = await TraceResources.create();
  const writer = await TraceWriter.create(resources);
  const driver = new Driver();
  const original = driver.request.bind(driver);
  const error = new Error('start reply lost');
  driver.request = async (method, parameters) => { await original(method, parameters); if (method.endsWith('.start')) throw error; return null; };
  try {
    await assert.rejects(TraceFilmstripChannel.start(driver, 'context', 'generation', clock, resources, writer, page => page), candidate => candidate === error);
    assert.equal(driver.calls.filter(call => call.method.endsWith('.dispose')).length, 1);
    assert.equal(resources.leases, 1);
    assert.equal(writer.failure, undefined, 'settled startup cleanup does not poison a successor recording');
  } finally { await writer.dispose(); await resources.dispose(); }
});
console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
