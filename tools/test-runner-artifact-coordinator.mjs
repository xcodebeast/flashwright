import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { RunnerArtifactCoordinator } = require('../packages/flashwright-runner/dist/commonjs/runner-artifact-coordinator.js');
const { Tracing } = require('../packages/flashwright-core/dist/commonjs/tracing.js');
const { TraceWriter } = require('../packages/flashwright-core/dist/commonjs/trace-writer.js');
const { adoptRunnerTraceAtStart } = require('../packages/flashwright-runner/dist/commonjs/runner-trace-journal.js');
const { installRunnerTraceFinalizer } = require('../packages/flashwright-runner/dist/commonjs/runner-trace-finalizer.js');
const { runnerIntegration } = require('../packages/flashwright-core/dist/commonjs/runner-integration.js');
const { beginRunnerContextCreation, completeRunnerContextCreation, didCreateRunnerContext, willCloseRunnerContext } = require('../packages/flashwright-core/dist/commonjs/runner-lifecycle.js');
const { utils } = require('playwright-core/lib/coreBundle');
const directory = await mkdtemp(join(tmpdir(), 'flashwright-coordinator-'));
const report = { status: 'running', checks: [] };
let ordinal = 0;
const turn = () => new Promise(resolve => setImmediate(resolve));
async function check(name, callback) { await callback(); report.checks.push(name); }

function information({ abandon = false, off = false, snapshots = false } = {}) {
  const main = { timeout: 1000, elapsed: 0 };
  const final = { timeout: 1000, elapsed: 0 };
  const context = { type: 'context-options', version: 8, origin: 'testRunner', monotonicTime: 10, wallTime: 20, options: {} };
  const identifier = ++ordinal;
  return {
    timeout: 1000, status: 'passed', expectedStatus: 'passed', errors: [], attachments: [], _stepMap: new Map(),
    outputPath: name => join(directory, `${identifier}-${name}`),
    _timeoutManager: { _running: { slot: final, runnable: { type: 'test', slot: final } }, defaultSlot: () => main, setTimeout(value) { this._running.slot.timeout = value; } },
    _tracing: {
      _contextCreatedEvent: context, _traceEvents: [context],
      traceOptions: () => off ? undefined : { sources: false, screenshots: false, snapshots, attachments: true, live: false },
      _shouldAbandonTrace: () => abandon,
      stopIfNeeded() { throw Error('original finalizer was called'); },
    },
  };
}

function context() {
  const value = new EventEmitter();
  const calls = [];
  const driver = { intercept: async () => {}, async request(method, parameters) {
    calls.push({ method, parameters });
    await this.intercept(method, parameters);
    if (method === 'context.trace.recording.status') return { recording: parameters.recording, networkPending: false };
    if (method === 'context.trace.network.pull') return { recording: parameters.recording, resources: [], pending: false };
    if (method === 'context.trace.network.entry') return { done: true, count: 0 };
    if (method === 'context.trace.recording.clock') return { nativeTime: 1 };
    if (method === 'context.trace.chunk.seal') return { lastEventSequence: 7 };
    if (method === 'context.trace.chunk.status') return { ...parameters, accepting: false, snapshotPending: false };
    if (method === 'context.trace.snapshot.pull') return { ...parameters, snapshots: [], pending: false };
    if (method === 'context.trace.pull' || method === 'context.trace.stop') return { generation: parameters.generation, events: [] };
    return null;
  } };
  value.tracing = new Tracing(driver, `context-${++ordinal}`, null);
  value.browser = () => ({ contexts: () => [value] });
  value.pages = () => [];
  value.calls = calls;
  value.driver = driver;
  value.close = async () => { await willCloseRunnerContext(value); value.tracing.ownerClosed(); value.emit('close'); await value.tracing.cleanup; };
  return value;
}

async function publish(value, claim = beginRunnerContextCreation()) {
  try { await didCreateRunnerContext(value, claim); }
  finally { completeRunnerContextCreation(claim); }
}
async function libraries(testInfo) {
  assert.equal(testInfo.attachments.filter(item => item.name === 'trace-error').length, 0);
  const attachment = testInfo.attachments.find(item => item.name === 'trace');
  assert(attachment);
  const archive = new utils.ZipFile(attachment.path);
  try {
    const entries = await archive.entries();
    assert(entries.includes('test.trace'));
    return await Promise.all(entries.filter(name => /^\d+-trace\.trace$/.test(name)).map(async name => (await archive.read(name)).toString()));
  } finally { archive.close(); }
}

try {
  await check('original attempts reuse an idle recording and finalize distinct library chunks', async () => {
    const coordinator = new RunnerArtifactCoordinator();
    const first = information();
    const value = context();
    try {
      assert.equal(coordinator.start(first), true);
      await coordinator.ready(); await publish(value);
      const recording = runnerIntegration.currentTraceRecording(7, value.tracing);
      const firstChunk = runnerIntegration.currentTraceChunk(3, value.tracing);
      await first._tracing.stopIfNeeded();
      assert.equal((await libraries(first)).length, 1);
      assert.equal(runnerIntegration.currentTraceChunk(3, value.tracing), undefined);
      const second = information(); coordinator.start(second); await coordinator.ready();
      assert.equal(runnerIntegration.currentTraceRecording(7, value.tracing), recording);
      assert.notEqual(runnerIntegration.currentTraceChunk(3, value.tracing), firstChunk);
      await value.close();
      await second._tracing.stopIfNeeded();
      assert.equal((await libraries(second)).length, 1);
      assert.equal(coordinator.recordings.size, 0);
      await turn(); assert.equal(coordinator.outstandingCaptures, 0);
    } finally { await value.close(); await coordinator.dispose(); }
  });
  await check('late old creation waits for a later explicit boundary before trace enrollment', async () => {
    const coordinator = new RunnerArtifactCoordinator();
    const first = information({ abandon: true }); coordinator.start(first); await coordinator.ready();
    const oldClaim = beginRunnerContextCreation();
    const value = context();
    try {
      await first._tracing.stopIfNeeded();
      assert.equal(coordinator.outstandingCaptures, 1);
      const second = information(); coordinator.start(second); await coordinator.ready();
      await publish(value, oldClaim);
      assert.equal(runnerIntegration.currentTraceChunk(3, value.tracing), undefined);
      assert.equal(value.calls.length, 0, 'late publication cannot enroll into a successor');
      await second._tracing.stopIfNeeded(); assert.equal((await libraries(second)).length, 0);
      const third = information(); coordinator.start(third); await coordinator.ready();
      assert(runnerIntegration.currentTraceChunk(3, value.tracing));
      await third._tracing.stopIfNeeded(); assert.equal((await libraries(third)).length, 1);
      await turn(); assert.equal(coordinator.outstandingCaptures, 0);
    } finally { completeRunnerContextCreation(oldClaim); await value.close(); await coordinator.dispose(); }
  });
  await check('pending creation admission is bounded without rejecting ordinary creation', async () => {
    const coordinator = new RunnerArtifactCoordinator();
    const testInfo = information(); coordinator.start(testInfo); await coordinator.ready();
    const claims = Array.from({ length: 129 }, () => beginRunnerContextCreation());
    const value = context();
    try {
      assert.equal(coordinator.outstandingCaptures, 128);
      await publish(value, claims.pop());
      assert.equal(value.calls.length, 0);
      for (const claim of claims) completeRunnerContextCreation(claim);
      await testInfo._tracing.stopIfNeeded();
      assert.equal(testInfo.status, 'passed'); assert.deepEqual(testInfo.errors, []);
      assert.match(testInfo.attachments.find(item => item.name === 'trace-error').body.toString(), /128 captures/);
      await turn(); assert.equal(coordinator.outstandingCaptures, 0);
    } finally { for (const claim of claims) completeRunnerContextCreation(claim); await value.close(); await coordinator.dispose(); }
  });
  await check('pending original attempts share the 256 worker capture limit until successful cleanup', async () => {
    const coordinator = new RunnerArtifactCoordinator();
    const claims = [];
    const finalizers = [];
    const value = context();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const testInfo = information({ abandon: true }); coordinator.start(testInfo); await coordinator.ready();
        finalizers.push(installRunnerTraceFinalizer(testInfo, adoptRunnerTraceAtStart(testInfo), coordinator.current));
        claims.push(...Array.from({ length: 128 }, () => beginRunnerContextCreation()));
        await testInfo._tracing.stopIfNeeded();
        assert.equal(coordinator.outstandingCaptures, (attempt + 1) * 128);
      }
      const successor = information(); coordinator.start(successor); await coordinator.ready();
      await publish(value);
      assert.equal(value.calls.length, 0, 'worker admission is rejected before optional native allocation');
      await successor._tracing.stopIfNeeded();
      assert.equal(successor.status, 'passed'); assert.deepEqual(successor.errors, []);
      assert.match(successor.attachments.find(item => item.name === 'trace-error').body.toString(), /256 outstanding/);
      assert.equal(coordinator.outstandingCaptures, 256);
      for (const claim of claims) completeRunnerContextCreation(claim);
      await Promise.all(finalizers.map(finalizer => finalizer.cleanup));
      assert.equal(coordinator.outstandingCaptures, 0);
      const later = information(); coordinator.start(later); await coordinator.ready();
      await later._tracing.stopIfNeeded();
      assert.equal((await libraries(later)).length, 1);
    } finally { for (const claim of claims) completeRunnerContextCreation(claim); await value.close(); await coordinator.dispose(); }
  });
  await check('manual recording collision preserves the context and manual recording', async () => {
    const coordinator = new RunnerArtifactCoordinator();
    const value = context(); await value.tracing.start();
    const original = runnerIntegration.currentTraceRecording(7, value.tracing);
    const testInfo = information(); coordinator.start(testInfo); await coordinator.ready();
    try {
      await publish(value);
      assert.equal(runnerIntegration.currentTraceRecording(7, value.tracing), original);
      await testInfo._tracing.stopIfNeeded();
      assert.equal(testInfo.status, 'passed');
      assert.match(testInfo.attachments.find(item => item.name === 'trace-error').body.toString(), /already started/);
      assert.equal(runnerIntegration.currentTraceRecording(7, value.tracing), original);
      await turn(); assert.equal(coordinator.recordings.size, 0);
      assert.equal(coordinator.activeCaptures.get(value), undefined);
      await value.tracing.stop();
    } finally { await value.close(); await coordinator.dispose(); }
  });
  await check('changed native capture options retire the old recording before reuse', async () => {
    const coordinator = new RunnerArtifactCoordinator(); const value = context();
    try {
      const first = information(); coordinator.start(first); await coordinator.ready(); await publish(value);
      const original = runnerIntegration.currentTraceRecording(7, value.tracing);
      await first._tracing.stopIfNeeded();
      const second = information({ snapshots: true }); coordinator.start(second); await coordinator.ready();
      assert.notEqual(runnerIntegration.currentTraceRecording(7, value.tracing), original);
      assert.equal(value.calls.filter(call => call.method === 'context.trace.recording.start').length, 1);
      await second._tracing.stopIfNeeded(); assert.equal((await libraries(second)).length, 1);
    } finally { await value.close(); await coordinator.dispose(); }
  });
  await check('failed export retires its exact chunk and permits a healthy successor capture', async () => {
    const coordinator = new RunnerArtifactCoordinator(); const value = context();
    try {
      const first = information(); coordinator.start(first); await coordinator.ready(); await publish(value);
      const original = runnerIntegration.currentTraceRecording(7, value.tracing);
      value.tracing.chunk.writer.fail(Error('original content failure'));
      await first._tracing.stopIfNeeded();
      assert.match(first.attachments.find(item => item.name === 'trace-error').body.toString(), /original content failure/);
      assert.equal(coordinator.recordings.get(value).capture, undefined);
      assert.equal(coordinator.activeCaptures.get(value), undefined);
      await turn(); assert.equal(coordinator.outstandingCaptures, 0);
      const second = information(); coordinator.start(second); await coordinator.ready();
      assert.equal(runnerIntegration.currentTraceRecording(7, value.tracing), original);
      await second._tracing.stopIfNeeded(); assert.equal((await libraries(second)).length, 1);
    } finally { await value.close(); await coordinator.dispose(); }
  });
  await check('worker disposal waits for pending reused startup before sealing its original chunk', async () => {
    const coordinator = new RunnerArtifactCoordinator(); const value = context();
    let enter; const entered = new Promise(resolve => { enter = resolve; });
    let release; const released = new Promise(resolve => { release = resolve; });
    try {
      const first = information(); coordinator.start(first); await coordinator.ready(); await publish(value);
      await first._tracing.stopIfNeeded();
      value.driver.intercept = async method => { if (method === 'context.trace.start') { enter(); await released; } };
      const second = information(); coordinator.start(second); await entered;
      let disposed = false; const disposal = coordinator.dispose().then(() => { disposed = true; });
      await turn(); assert.equal(disposed, false);
      release(); await disposal; await coordinator.ready();
      assert.equal(coordinator.recordings.size, 0);
      await second._tracing.stopIfNeeded(); assert.equal((await libraries(second)).length, 1);
    } finally { release(); await value.close(); await coordinator.dispose(); }
  });
  await check('failed reused startup releases original attempt custody after successful cleanup', async () => {
    const coordinator = new RunnerArtifactCoordinator(); const value = context();
    try {
      const first = information(); coordinator.start(first); await coordinator.ready(); await publish(value);
      await first._tracing.stopIfNeeded();
      let fail = true;
      value.driver.intercept = async method => { if (method === 'context.trace.start' && fail) { fail = false; throw Error('reused startup failure'); } };
      const second = information(); coordinator.start(second); await coordinator.ready(); await second._tracing.stopIfNeeded();
      assert.match(second.attachments.find(item => item.name === 'trace-error').body.toString(), /reused startup failure/);
      assert.equal(coordinator.recordings.get(value).capture, undefined);
      assert.equal(coordinator.activeCaptures.get(value), undefined);
      const third = information(); coordinator.start(third); await coordinator.ready(); await third._tracing.stopIfNeeded();
      assert.equal((await libraries(third)).length, 1);
    } finally { await value.close(); await coordinator.dispose(); }
  });
  await check('late reused startup cleanup retires the original recording after worker disposal', async () => {
    const coordinator = new RunnerArtifactCoordinator(); const value = context();
    const originalDispose = TraceWriter.prototype.dispose;
    let enter; const entered = new Promise(resolve => { enter = resolve; });
    let release; const released = new Promise(resolve => { release = resolve; });
    try {
      const first = information(); coordinator.start(first); await coordinator.ready(); await publish(value); await first._tracing.stopIfNeeded();
      TraceWriter.prototype.dispose = async function() { enter(); await released; return originalDispose.call(this); };
      let fail = true;
      value.driver.intercept = async method => { if (method === 'context.trace.start' && fail) { fail = false; throw Error('late reused failure'); } };
      const second = information(); coordinator.start(second); await entered; await coordinator.ready();
      const finalizer = installRunnerTraceFinalizer(second, adoptRunnerTraceAtStart(second), coordinator.current);
      await coordinator.dispose();
      assert.equal(coordinator.recordings.size, 1);
      await second._tracing.stopIfNeeded();
      assert.equal(coordinator.outstandingCaptures, 1);
      release(); await finalizer.cleanup;
      assert.equal(finalizer.cleanupSucceeded, true);
      assert.equal(coordinator.recordings.size, 0);
      assert.equal(coordinator.outstandingCaptures, 0);
      assert.equal(runnerIntegration.currentTraceRecording(7, value.tracing), undefined);
    } finally { release(); TraceWriter.prototype.dispose = originalDispose; await value.close(); await coordinator.dispose(); }
  });
  await check('manual chunk retirement keeps original attempt admission through late cleanup', async () => {
    const coordinator = new RunnerArtifactCoordinator(); const value = context();
    const originalDispose = TraceWriter.prototype.dispose;
    let enter; const entered = new Promise(resolve => { enter = resolve; });
    let release; const released = new Promise(resolve => { release = resolve; });
    let manual;
    try {
      const first = information(); coordinator.start(first); await coordinator.ready(); await publish(value);
      const finalizer = installRunnerTraceFinalizer(first, adoptRunnerTraceAtStart(first), coordinator.current);
      TraceWriter.prototype.dispose = async function() { enter(); await released; return originalDispose.call(this); };
      manual = value.tracing.stopChunk(); void manual.catch(() => {}); await entered;
      await first._tracing.stopIfNeeded();
      assert.equal(coordinator.outstandingCaptures, 1);
      assert.equal(finalizer.cleanupSucceeded, false);
      release(); await manual; await finalizer.cleanup;
      assert.equal(finalizer.cleanupSucceeded, true);
      assert.equal(coordinator.outstandingCaptures, 0);
      assert.equal(coordinator.recordings.get(value).capture, undefined);
      TraceWriter.prototype.dispose = originalDispose;
      const second = information(); coordinator.start(second); await coordinator.ready(); await second._tracing.stopIfNeeded();
      assert.equal((await libraries(second)).length, 1);
    } finally { release(); TraceWriter.prototype.dispose = originalDispose; await manual?.catch(() => {}); await value.close(); await coordinator.dispose(); }
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { await rm(directory, { recursive: true, force: true }); console.log(JSON.stringify(report)); }
