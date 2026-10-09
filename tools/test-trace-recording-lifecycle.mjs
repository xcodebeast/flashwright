import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { Tracing } = require('../packages/flashwright-core/dist/commonjs/tracing.js');
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
function start(tracing) { return tracing.control(() => tracing.startRecording({ snapshots: true })); }
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
      assert.deepEqual(driver.recordingCalls('stop')[0].parameters, driver.recordingCalls('start')[0].parameters);
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
      assert.deepEqual(driver.recordingCalls('stop')[0].parameters, driver.recordingCalls('start')[0].parameters);
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
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
