import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, readFile, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { Tracing } = require('../packages/flashwright-core/dist/commonjs/tracing.js');
const { TraceWriter } = require('../packages/flashwright-core/dist/commonjs/trace-writer.js');
const { failure, fromRecord } = require('../packages/flashwright-core/dist/commonjs/errors.js');

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

class RecordingDriver {
  calls = [];
  intercept = async () => undefined;
  async request(method, parameters) {
    this.calls.push({ method, parameters });
    const intercepted = await this.intercept(method, parameters);
    if (intercepted !== undefined) return intercepted;
    if (method === 'context.trace.recording.status') return { recording: parameters.recording, networkPending: false };
    if (method === 'context.trace.network.pull') return { recording: parameters.recording, resources: [], pending: false };
    if (method === 'context.trace.network.entry') return { done: true, count: 0 };
    if (method === 'context.trace.recording.clock') return { nativeTime: 1 };
    if (method === 'context.trace.chunk.seal') return { lastEventSequence: 7 };
    if (method === 'context.trace.chunk.status') return { ...parameters, accepting: false, snapshotPending: false };
    if (method === 'context.trace.snapshot.pull') return { ...parameters, snapshots: [], pending: false };
    if (method === 'context.trace.pull' || method === 'context.trace.stop') return { generation: parameters.generation, events: [] };
    return null;
  }
  recordingCalls(method) { return this.calls.filter(call => call.method === `context.trace.recording.${method}`); }
}

function fixture() {
  const driver = new RecordingDriver();
  const tracing = new Tracing(driver, 'original-context', { width: 800, height: 600 });
  return { driver, tracing };
}
function start(tracing) { return tracing.start({ snapshots: true }); }
async function freshRecording(tracing) { await start(tracing); await tracing.stop(); }
const report = { status: 'running', checks: [] };
async function check(name, callback) { await callback(); report.checks.push(name); }

try {
  await check('uncertain start retains exact cleanup owner beyond foreground grace and blocks successors', async () => {
    const { driver, tracing } = fixture();
    const stopEntered = deferred();
    const stopReleased = deferred();
    const originalFailure = failure('TimeoutError', 'context.trace.recording.start', 'accepted start reply crossed deadline');
    let firstStart = true;
    let firstStop = true;
    driver.intercept = async method => {
      if (method === 'context.trace.recording.start' && firstStart) { firstStart = false; throw originalFailure; }
      if (method === 'context.trace.recording.stop' && firstStop) { firstStop = false; stopEntered.resolve(); await stopReleased.promise; }
    };
    const starting = start(tracing);
    const rejection = assert.rejects(starting, error => error === originalFailure);
    try {
      await stopEntered.promise;
      await rejection;
      assert.ok(tracing.cleanup, 'background owner must survive the foreground grace');
      await assert.rejects(start(tracing), { name: 'ResourceLimitError' });
      assert.equal(driver.recordingCalls('start').length, 1);
      assert.deepEqual(driver.recordingCalls('stop')[0].parameters, { context: driver.recordingCalls('start')[0].parameters.context, recording: driver.recordingCalls('start')[0].parameters.recording });
      const cleanup = tracing.cleanup;
      stopReleased.resolve(); await cleanup;
      await freshRecording(tracing);
      assert.equal(driver.recordingCalls('start').length, 2);
      assert.notEqual(driver.recordingCalls('start')[0].parameters.recording, driver.recordingCalls('start')[1].parameters.recording);
    } finally { stopReleased.resolve(); await starting.catch(() => {}); await tracing.cleanup; tracing.ownerClosed(); }
  });

  await check('uncertain failed stop quarantines future setup without replacing original start error', async () => {
    const { driver, tracing } = fixture();
    const originalFailure = failure('TimeoutError', 'context.trace.recording.start', 'start uncertain');
    const cleanupFailure = failure('TimeoutError', 'context.trace.recording.stop', 'stop uncertain');
    driver.intercept = async method => {
      if (method === 'context.trace.recording.start') throw originalFailure;
      if (method === 'context.trace.recording.stop') throw cleanupFailure;
    };
    try {
      await assert.rejects(start(tracing), error => error === originalFailure);
      await assert.rejects(start(tracing), error => error === cleanupFailure);
      assert.equal(driver.recordingCalls('start').length, 1);
      assert.equal(driver.recordingCalls('stop').length, 1);
      assert.deepEqual(driver.recordingCalls('stop')[0].parameters, { context: driver.recordingCalls('start')[0].parameters.context, recording: driver.recordingCalls('start')[0].parameters.recording });
    } finally { tracing.ownerClosed(); await tracing.cleanup; }
  });

  await check('confirmed failed recording removal permits a new owner', async () => {
    const { driver, tracing } = fixture();
    let firstStart = true;
    let firstStop = true;
    driver.intercept = async method => {
      if (method === 'context.trace.recording.start' && firstStart) { firstStart = false; throw failure('TimeoutError', method, 'late accepted start'); }
      if (method === 'context.trace.recording.stop' && firstStop) {
        firstStop = false;
        throw fromRecord({ code: 'ProtocolError', method, message: 'original recording failed', cleanup: 'traceRecordingStopped' });
      }
    };
    try {
      await assert.rejects(start(tracing), { name: 'TimeoutError' });
      await freshRecording(tracing);
      assert.equal(driver.recordingCalls('start').length, 2);
      assert.equal(driver.recordingCalls('stop').length, 2);
    } finally { tracing.ownerClosed(); await tracing.cleanup; }
  });

  await check('definitively rejected start never sends stop against another native recording', async () => {
    const { driver, tracing } = fixture();
    driver.intercept = async method => {
      if (method === 'context.trace.recording.start') throw failure('InvalidArgumentError', method, 'another recording is active');
    };
    try {
      await assert.rejects(start(tracing), { name: 'InvalidArgumentError' });
      assert.equal(driver.recordingCalls('stop').length, 0);
    } finally { tracing.ownerClosed(); await tracing.cleanup; }
  });

  await check('failed clock sampling retries cleanup using the original unreturned chunk', async () => {
    const { driver, tracing } = fixture();
    const originalFailure = failure('TimeoutError', 'context.trace.recording.clock', 'clock response uncertain');
    let firstClock = true;
    let firstSeal = true;
    driver.intercept = async method => {
      if (method === 'context.trace.recording.clock' && firstClock) { firstClock = false; throw originalFailure; }
      if (method === 'context.trace.chunk.seal' && firstSeal) { firstSeal = false; throw failure('TimeoutError', method, 'seal response uncertain'); }
    };
    try {
      await assert.rejects(start(tracing), error => error === originalFailure);
      const chunkStart = driver.calls.find(call => call.method === 'context.trace.chunk.start');
      const seals = driver.calls.filter(call => call.method === 'context.trace.chunk.seal');
      assert.equal(seals.length, 2);
      assert.ok(seals.every(call => JSON.stringify(call.parameters) === JSON.stringify(chunkStart.parameters)));
      await freshRecording(tracing);
    } finally { tracing.ownerClosed(); await tracing.cleanup; }
  });
  await check('failed network export preserves pending custody and a confirmed retirement permits a fresh recording', async () => {
    const { driver, tracing } = fixture();
    const statusEntered = deferred();
    const statusReleased = deferred();
    const originalFailure = failure('ResourceLimitError', 'tracing.network', 'original export limit');
    let failedRecording;
    driver.intercept = async (method, parameters) => {
      if (method === 'context.trace.recording.start') failedRecording ??= parameters.recording;
      if (parameters.recording !== failedRecording) return;
      if (method === 'context.trace.network.entry') throw originalFailure;
      if (method === 'context.trace.chunk.status') { statusEntered.resolve(); await statusReleased.promise; }
      if (method === 'context.trace.recording.stop') throw fromRecord({ code: 'ResourceLimitError', method, message: 'original export limit', cleanup: 'traceRecordingStopped' });
    };
    try {
      await start(tracing);
      const stopping = tracing.stop();
      const rejected = assert.rejects(stopping, error => error === originalFailure);
      await statusEntered.promise;
      assert.equal(driver.recordingCalls('stop').length, 0, 'native pending work must settle before recording removal');
      await assert.rejects(start(tracing), { name: 'InvalidArgumentError' });
      statusReleased.resolve(); await rejected;
      assert.equal(driver.recordingCalls('stop').length, 1);
      await freshRecording(tracing);
      assert.equal(driver.recordingCalls('start').length, 2);
      assert.equal(driver.recordingCalls('stop').length, 2);
    } finally { statusReleased.resolve(); tracing.ownerClosed(); await tracing.cleanup; }
  });
  await check('a retained sealed archive does not quarantine confirmed native retirement or a successor recording', async () => {
    const { driver, tracing } = fixture();
    const originalFinish = TraceWriter.prototype.finish;
    let archive;
    // Model the runner's private handoff at the already-drained writer boundary.
    TraceWriter.prototype.finish = async function(_path, signal) { archive = await this.takeArchive(signal); };
    try {
      await start(tracing);
      const retiredResources = tracing.resources;
      await tracing.stop();
      TraceWriter.prototype.finish = originalFinish;
      assert.equal(driver.recordingCalls('stop').length, 1);
      assert.equal(tracing.cleanup, undefined);
      await access(retiredResources.directory);
      await start(tracing);
      assert.notEqual(tracing.resources, retiredResources);
      assert.notEqual(driver.recordingCalls('start')[0].parameters.recording, driver.recordingCalls('start')[1].parameters.recording);
      const reader = archive.acquire();
      try {
        const entry = reader.entries.find(entry => entry.name === 'trace.trace');
        assert.equal(JSON.parse((await readFile(entry.path, 'utf8')).trim()).type, 'context-options');
      } finally { reader.release(); }
      await archive.dispose();
      await assert.rejects(access(retiredResources.directory), { code: 'ENOENT' });
      await access(tracing.resources.directory);
      await tracing.stop();
      assert.equal(driver.recordingCalls('stop').length, 2);
    } finally {
      TraceWriter.prototype.finish = originalFinish;
      await archive?.dispose();
      tracing.ownerClosed(); await tracing.cleanup;
    }
  });
  await check('context closure settles active resource custody without deleting a retained chunk', async () => {
    const { tracing } = fixture();
    const originalFinish = TraceWriter.prototype.finish;
    let archive;
    TraceWriter.prototype.finish = async function(_path, signal) { archive = await this.takeArchive(signal); };
    try {
      await start(tracing);
      const retainedResources = tracing.resources;
      await tracing.stopChunk();
      TraceWriter.prototype.finish = originalFinish;
      await tracing.beforeOwnerClose();
      tracing.ownerClosed();
      await tracing.cleanup;
      assert.equal(tracing.cleanup, undefined);
      await assert.rejects(start(tracing), { name: 'TargetClosedError' });
      await access(retainedResources.directory);
      const reader = archive.acquire();
      try { assert((await readFile(reader.entries.find(entry => entry.name === 'trace.trace').path)).length > 0); }
      finally { reader.release(); }
      await archive.dispose();
      await assert.rejects(access(retainedResources.directory), { code: 'ENOENT' });
    } finally {
      TraceWriter.prototype.finish = originalFinish;
      await archive?.dispose();
      tracing.ownerClosed(); await tracing.cleanup;
    }
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
