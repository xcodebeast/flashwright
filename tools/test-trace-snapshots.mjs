import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { TraceSnapshotChannel, sampleRecordingClock } = require('../packages/flashwright-core/dist/commonjs/trace-snapshots.js');
const { NativeTraceRecording } = require('../packages/flashwright-core/dist/commonjs/trace-recording.js');
const { TraceResources } = require('../packages/flashwright-core/dist/commonjs/trace-resources.js');
const { TraceWriter } = require('../packages/flashwright-core/dist/commonjs/trace-writer.js');
const { tryAcquireTraceTransfer } = require('../packages/flashwright-core/dist/commonjs/trace-transfers.js');
const checks = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const identity = { context: 'context', recording: 'recording', chunk: 'chunk' };
const clock = { nativeTime: 5, hostBefore: 104, hostAfter: 106, offset: 100, uncertainty: 1 };
class Driver {
  calls = [];
  bytes = Buffer.from(JSON.stringify({ html: ['HTML', {}, ['BODY', {}, 'exact\ud800text']], url: 'https://example.test/', doctype: 'html', viewport: { width: 800, height: 600 }, wallTime: 1, collectionTime: 0, resourceOverrides: [{ url: 'https://example.test/style.css', content: 'body { color: red; }', contentType: 'text/css' }] }));
  metadata = [{ capture: 'capture', call: 'call', phase: 'input', page: 'page', frame: 'frame', isMainFrame: true, snapshotNumber: 1, nativeTime: -1, byteLength: this.bytes.length }];
  pending = true;
  batchIdentity = identity;
  async request(method, parameters) {
    this.calls.push({ method, parameters });
    if (method.endsWith('.clock')) return { nativeTime: -1 };
    if (method.endsWith('.pull')) return { ...this.batchIdentity, snapshots: this.metadata.splice(0), pending: this.pending };
    if (method.endsWith('.ingested')) this.pending = false;
    if (method.endsWith('.seal')) return { lastEventSequence: 17 };
    if (method.endsWith('.status')) return { ...parameters, accepting: false, snapshotPending: false };
    return null;
  }
  async requestTraceAttachment(method, parameters) { this.calls.push({ method, parameters }); return Buffer.from(this.bytes); }
}
async function fixture(driver = new Driver()) {
  const resources = await TraceResources.create();
  const writer = await TraceWriter.create(resources);
  const channel = new TraceSnapshotChannel(driver, identity, clock, resources, writer, page => `trace/${page}`);
  clearTimeout(channel.timer);
  return { driver, resources, writer, channel, async dispose() { channel.ownerClosed(); await channel.stop(); await writer.dispose(); await resources.dispose(); } };
}
function poll(channel) {
  const work = channel.poll(); channel.polling = work;
  return work.finally(() => { if (channel.polling === work) channel.polling = undefined; });
}
async function check(name, callback) { await callback(); checks.push(name); }
const report = { status: 'running', checks };
try {
  await check('recording clock accepts signed original ingress independently of filmstrip', async () => {
    const driver = new Driver();
    const sample = await sampleRecordingClock(driver, 'context', 'recording');
    assert.equal(driver.calls.length, 3);
    assert.ok(driver.calls.every(call => call.method === 'context.trace.recording.clock' && call.parameters.recording === 'recording'));
    assert.equal(sample.nativeTime, -1);
    assert.equal(sample.nativeTime + sample.offset, (sample.hostBefore + sample.hostAfter) / 2);
  });
  await check('stylesheet and streamed snapshot finish before native ACK with original timestamp and call', async () => {
    const state = await fixture();
    try {
      await poll(state.channel);
      await state.channel.stop();
      const lines = (await readFile(join(state.writer.directory, 'trace.trace'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(lines.length, 1);
      const snapshot = lines[0].snapshot;
      assert.equal(snapshot.timestamp, 99);
      assert.equal(snapshot.pageId, 'trace/page');
      assert.equal(snapshot.frameId, 'frame');
      assert.equal(snapshot.snapshotName, 'input@call');
      assert.equal(snapshot.frameUrl, 'https://example.test/');
      assert.equal(snapshot.html[2][2], 'exact\ud800text');
      const alias = snapshot.resourceOverrides[0].sha1;
      assert.match(alias, /^[a-f0-9]{64}\.css$/);
      assert.equal(await readFile(state.writer.aliases.get(`resources/${alias}`).path, 'utf8'), 'body { color: red; }');
      const acknowledgements = state.driver.calls.filter(call => call.method.endsWith('.ingested'));
      assert.deepEqual(acknowledgements.map(call => call.parameters), [{ ...identity, capture: 'capture', success: true }]);
      assert.equal(state.writer.failure, undefined);
    } finally { await state.dispose(); }
  });
  await check('write cancellation retains transfer ownership until ingestion settles and never ACKs success', async () => {
    const state = await fixture();
    const entered = deferred(); const release = deferred();
    state.writer.appendSnapshot = async (_event, signal) => { entered.resolve(); await release.promise; signal.throwIfAborted(); };
    const work = poll(state.channel);
    try {
      await entered.promise;
      assert.equal(tryAcquireTraceTransfer(state.driver, 'context'), undefined);
      const other = tryAcquireTraceTransfer(state.driver, 'other');
      assert.equal(typeof other, 'function');
      assert.equal(tryAcquireTraceTransfer(state.driver, 'third'), undefined);
      other();
      const cancellation = new AbortController();
      const stopped = state.channel.stop(cancellation.signal);
      cancellation.abort(new Error('controlled write abort'));
      assert.equal(tryAcquireTraceTransfer(state.driver, 'context'), undefined);
      assert.equal(state.driver.calls.filter(call => call.method.endsWith('.ingested')).length, 0);
      release.resolve(); await work; await stopped;
      assert.equal(state.driver.calls.filter(call => call.method.endsWith('.ingested')).length, 0);
      assert.equal(state.driver.calls.filter(call => call.method === 'context.trace.recording.fail').length, 1);
      const successor = tryAcquireTraceTransfer(state.driver, 'context');
      assert.equal(typeof successor, 'function'); successor();
      assert.match(String(state.writer.failure), /controlled write abort/);
    } finally { release.resolve(); await work; await state.dispose(); }
  });
  await check('stale chunk metadata fails before allocating attachment or acknowledging bytes', async () => {
    const driver = new Driver(); driver.batchIdentity = { ...identity, chunk: 'successor' };
    const state = await fixture(driver);
    try {
      await poll(state.channel); await state.channel.stop();
      assert.match(String(state.writer.failure), /invalid original snapshot batch/);
      assert.equal(driver.calls.filter(call => call.method.endsWith('.take') || call.method.endsWith('.ingested')).length, 0);
    } finally { await state.dispose(); }
  });
  await check('one native recording spans gaps and gives both consumers one original cutoff', async () => {
    const driver = new Driver();
    const recording = new NativeTraceRecording(driver, 'context');
    await recording.start();
    const first = await recording.startChunk('first');
    assert.equal(first.clock.nativeTime, -1);
    const cutoff = await first.seal();
    assert.equal(await first.seal(), cutoff);
    assert.deepEqual(cutoff, { lastEventSequence: 17 });
    await recording.retireChunk(first);
    const second = await recording.startChunk('second');
    assert.equal(first.identity.recording, second.identity.recording);
    await recording.retireChunk(second);
    await recording.stop();
    assert.equal(driver.calls.filter(call => call.method === 'context.trace.recording.start').length, 1);
    assert.equal(driver.calls.filter(call => call.method === 'context.trace.recording.stop').length, 1);
    assert.deepEqual(driver.calls.filter(call => call.method === 'context.trace.chunk.seal').map(call => call.parameters.chunk), ['first', 'second']);
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
