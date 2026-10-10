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
const { instrumentTraceMethods } = require('../packages/flashwright-core/dist/commonjs/trace-hooks.js');
const runnerGlobals = require('../packages/flashwright-runner/dist/upstream/lib/globals.js');
const { beginRunnerContextCreation, completeRunnerContextCreation, didCreateRunnerContext, willCloseRunnerContext } = require('../packages/flashwright-core/dist/commonjs/runner-lifecycle.js');
const { beginRunnerRequestCreation, publishRunnerRequestContext } = require('../packages/flashwright-core/dist/commonjs/runner-request-lifecycle.js');
const { APIRequestContext } = require('../packages/flashwright-core/dist/commonjs/api-request.js');
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

function requestContext() {
  const calls = [];
  let closed = false;
  let listener;
  const client = {
    subscribeObject(_identifier, callback) { listener = callback; return () => {}; },
    isClosed: () => closed,
    intercept: async () => {},
    async request(method, parameters) { calls.push({ method, parameters }); await this.intercept(method, parameters); return null; },
    async release() {},
  };
  const value = new APIRequestContext(client, `request-context-${++ordinal}`, { timeout: 30000, maxRedirects: 20, failOnStatusCode: false, hasContentType: false });
  return { value, calls, client, disconnect() { closed = true; listener({ event: 'transportclosed' }); } };
}

async function publishRequest(value, claim = beginRunnerRequestCreation()) {
  try { await publishRunnerRequestContext(value, claim); }
  finally { claim.complete(); }
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
  await check('already-published API contexts join the first original attempt', async () => {
    const request = requestContext();
    await publishRequest(request.value);
    const coordinator = new RunnerArtifactCoordinator();
    try {
      const first = information(); coordinator.start(first); await coordinator.ready();
      assert(runnerIntegration.currentTraceChunk(3, runnerIntegration.requestTraceOwner(12, request.value)));
      await first._tracing.stopIfNeeded();
      assert.equal((await libraries(first)).length, 1);
      await turn(); assert.equal(coordinator.outstandingCaptures, 0);
    } finally { await request.value.dispose(); await coordinator.dispose(); }
  });
  await check('API retirement requires a confirmed fence before cleanup can release admission', async () => {
    for (const failures of [1, 2]) {
      const coordinator = new RunnerArtifactCoordinator();
      const request = requestContext();
      let retirements = 0;
      request.client.intercept = async method => {
        if (method === 'apiRequest.traceBody.retire' && ++retirements <= failures) {
          const error = Error('original retirement admission failure'); error.name = 'ResourceLimitError'; throw error;
        }
      };
      try {
        const first = information(); coordinator.start(first); await coordinator.ready(); await publishRequest(request.value);
        const finalizer = installRunnerTraceFinalizer(first, adoptRunnerTraceAtStart(first), coordinator.current);
        await first._tracing.stopIfNeeded();
        assert.equal(first.status, 'passed'); assert.equal(first.attachments.filter(item => item.name === 'trace').length, 0);
        assert.match(first.attachments.find(item => item.name === 'trace-error').body.toString(), /original retirement admission failure/);
        assert.equal(retirements, 2, 'failed export gets one original-generation cleanup retry');
        await finalizer.cleanup;
        assert.equal(finalizer.cleanupSucceeded, failures === 1);
        assert.equal(coordinator.outstandingCaptures, failures === 1 ? 0 : 1);
        if (failures === 1) {
          const second = information(); coordinator.start(second); await coordinator.ready(); await second._tracing.stopIfNeeded();
          assert.equal((await libraries(second)).length, 1);
        } else {
          await assert.rejects(runnerIntegration.requestTraceOwner(12, request.value).startChunk(), /cleanup|retirement admission failure/);
        }
      } finally { await request.value.dispose(); await coordinator.dispose(); }
    }
  });
  await check('API and browser contexts share original attempt archives and capture admission', async () => {
    const coordinator = new RunnerArtifactCoordinator();
    const browser = context();
    const request = requestContext();
    try {
      const first = information({ snapshots: true }); coordinator.start(first); await coordinator.ready();
      await publish(browser); await publishRequest(request.value);
      assert.equal(coordinator.outstandingCaptures, 2);
      assert.equal(coordinator.contexts.has(request.value), false, 'API owners are not screenshot subjects');
      const tracing = runnerIntegration.requestTraceOwner(12, request.value);
      const recording = runnerIntegration.currentTraceRecording(7, tracing);
      await first._tracing.stopIfNeeded();
      assert.equal((await libraries(first)).length, 2);
      const second = information({ snapshots: true }); coordinator.start(second); await coordinator.ready();
      assert.equal(runnerIntegration.currentTraceRecording(7, tracing), recording);
      await request.value.dispose(); await browser.close();
      await second._tracing.stopIfNeeded();
      assert.equal((await libraries(second)).length, 2);
      assert.deepEqual(request.calls.map(call => call.method), ['apiRequest.traceBody.retire', 'apiRequest.traceBody.retire', 'apiRequest.dispose']);
      assert.equal(coordinator.recordings.size, 0);
      await turn(); assert.equal(coordinator.outstandingCaptures, 0);
    } finally { await request.value.dispose(); await browser.close(); await coordinator.dispose(); }
  });
  await check('late API publication cannot move from an abandoned attempt to its successor', async () => {
    const coordinator = new RunnerArtifactCoordinator();
    const first = information({ abandon: true }); coordinator.start(first); await coordinator.ready();
    const claim = beginRunnerRequestCreation();
    const request = requestContext();
    try {
      await first._tracing.stopIfNeeded();
      const second = information(); coordinator.start(second); await coordinator.ready();
      await publishRequest(request.value, claim);
      assert.equal(request.calls.length, 0);
      assert.equal(runnerIntegration.currentTraceChunk(3, runnerIntegration.requestTraceOwner(12, request.value)), undefined);
      await second._tracing.stopIfNeeded(); assert.equal((await libraries(second)).length, 0);
      const third = information(); coordinator.start(third); await coordinator.ready();
      await third._tracing.stopIfNeeded(); assert.equal((await libraries(third)).length, 1);
    } finally { claim.complete(); await request.value.dispose(); await coordinator.dispose(); }
  });
  await check('API transport loss settles the exact recording and removes future enrollment', async () => {
    const coordinator = new RunnerArtifactCoordinator();
    const request = requestContext();
    try {
      const first = information(); coordinator.start(first); await coordinator.ready(); await publishRequest(request.value);
      request.disconnect();
      await coordinator.dispose();
      await first._tracing.stopIfNeeded();
      assert.equal(coordinator.recordings.size, 0);
      assert.equal(coordinator.requestContexts.size, 0);
      assert.equal(first.attachments.filter(item => item.name === 'trace').length, 0);
      assert.match(first.attachments.find(item => item.name === 'trace-error').body.toString(), /context closed before its original trace chunk/);
      assert.equal(request.calls.length, 0, 'closed transport cannot receive cleanup commands');
    } finally { await request.value.dispose(); await coordinator.dispose(); }
  });
  await check('API and browser pending creations share the same 128 attempt slots', async () => {
    const coordinator = new RunnerArtifactCoordinator();
    const attempt = information(); coordinator.start(attempt); await coordinator.ready();
    const browserClaims = Array.from({ length: 64 }, () => beginRunnerContextCreation());
    const requestClaims = Array.from({ length: 65 }, () => beginRunnerRequestCreation());
    try {
      assert.equal(coordinator.outstandingCaptures, 128);
      for (const claim of browserClaims) completeRunnerContextCreation(claim);
      for (const claim of requestClaims) claim.complete();
      await attempt._tracing.stopIfNeeded();
      assert.equal(attempt.status, 'passed');
      assert.equal(attempt.attachments.filter(item => item.name === 'trace').length, 0);
      assert.match(attempt.attachments.find(item => item.name === 'trace-error').body.toString(), /128 captures/);
      await turn(); assert.equal(coordinator.outstandingCaptures, 0);
    } finally {
      for (const claim of browserClaims) completeRunnerContextCreation(claim);
      for (const claim of requestClaims) claim.complete();
      await coordinator.dispose();
    }
  });
  await check('invalid policy owns finalization without enrolling existing contexts or accepting creation', async () => {
    const coordinator = new RunnerArtifactCoordinator();
    coordinator.configureScreenshots({ mode: 'on', options: {} });
    const value = context();
    try {
      await coordinator.ready(); await publish(value);
      const rejected = information();
      coordinator.start(rejected, { error: Error('original invalid policy') });
      await coordinator.ready();
      assert.equal(value.calls.length, 0);
      assert.equal(coordinator.outstandingCaptures, 0);
      assert.equal(coordinator.current.active, false);
      await rejected._tracing.stopIfNeeded();
      assert.equal(rejected.attachments.filter(item => item.name === 'trace').length, 0);
      assert.match(rejected.attachments.find(item => item.name === 'trace-error').body.toString(), /original invalid policy/);
      const successor = information(); coordinator.start(successor); await coordinator.ready();
      await successor._tracing.stopIfNeeded(); assert.equal((await libraries(successor)).length, 1);
    } finally { await value.close(); await coordinator.dispose(); }
  });
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
  await check('unclaimed late publication reports incomplete capture and permits later explicit enrollment', async () => {
    for (const installedBeforeCreation of [false, true]) {
      const coordinator = new RunnerArtifactCoordinator();
      if (installedBeforeCreation) {
        const previous = information(); coordinator.start(previous); await coordinator.ready(); await previous._tracing.stopIfNeeded();
      }
      const creation = beginRunnerContextCreation();
      const value = context();
      try {
        const first = information(); coordinator.start(first); await coordinator.ready();
        await publish(value, creation);
        assert.equal(value.calls.length, 0);
        assert.equal(coordinator.current.captureFailure.error.name, 'UnsupportedFeatureError');
        await first._tracing.stopIfNeeded();
        assert.equal(first.status, 'passed'); assert.deepEqual(first.errors, []);
        assert.equal(first.attachments.filter(attachment => attachment.name === 'trace').length, 0);
        assert.match(first.attachments.find(attachment => attachment.name === 'trace-error').body.toString(), /runner.tracing: context creation began before trace ownership/);
        const later = information(); coordinator.start(later); await coordinator.ready(); await later._tracing.stopIfNeeded();
        assert.equal((await libraries(later)).length, 1);
      } finally { completeRunnerContextCreation(creation); await value.close(); await coordinator.dispose(); }
    }
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
  await check('final stop closes creation and action admission before blocked failure-context sealing and publishes once', async () => {
    const coordinator = new RunnerArtifactCoordinator();
    const originalContext = context();
    const lateContext = context();
    const steps = [];
    let signalSealing;
    const sealingStarted = new Promise(resolve => { signalSealing = resolve; });
    let releaseSealing;
    const sealingReleased = new Promise(resolve => { releaseSealing = resolve; });
    let pendingClaim;
    let fallbackChecks = 0;
    const testInfo = Object.assign(information({ snapshots: true }), {
      status: 'failed', errors: [Object.freeze({ message: 'original lifecycle failure' })],
      titlePath: ['coordinator', 'original lifecycle failure'],
      file: join(directory, 'missing-source.ts'), line: 1, column: 1,
      _addStep(data) {
        const step = { ...data, stepId: `owned-step-${steps.length + 1}`, complete() {} };
        steps.push(step);
        this._stepMap.set(step.stepId, step);
        return step;
      },
    });
    class Operations {
      constructor(tracing) { this.tracing = tracing; }
      async evaluate(expression) { return expression; }
    }
    instrumentTraceMethods(Operations.prototype, 'Frame', operation => ({ tracing: operation.tracing }), {
      evaluate: { method: 'evaluateExpression', parameters: ['expression'] },
    });
    try {
      coordinator.start(testInfo);
      await coordinator.ready();
      await publish(originalContext);
      runnerGlobals.setCurrentTestInfo(testInfo);
      const operations = new Operations(originalContext.tracing);
      assert.equal(await operations.evaluate('before final stop'), 'before final stop');
      assert.equal(steps.length, 1, 'the active original attempt records ordinary actions');
      pendingClaim = beginRunnerContextCreation();
      originalContext.driver.intercept = async method => {
        if (method === 'context.trace.chunk.seal') { signalSealing(); await sealingReleased; }
      };
      originalContext.pages = () => { fallbackChecks++; return []; };
      const completion = testInfo._tracing.stopIfNeeded();
      assert.equal(testInfo._tracing.stopIfNeeded(), completion);
      await turn();
      assert.equal(fallbackChecks, 0, 'fallback waits for original admitted creation and trace sealing');
      assert.equal(await operations.evaluate('during pending original creation'), 'during pending original creation');
      assert.equal(steps.length, 1, 'final-stop admission closes before its first asynchronous wait');
      await publish(lateContext);
      assert.deepEqual(lateContext.calls, [], 'creation begun during final stop cannot start another original trace');
      completeRunnerContextCreation(pendingClaim);
      pendingClaim = undefined;
      await sealingStarted;
      assert.equal(fallbackChecks, 0, 'fallback cannot begin before the original native seal returns');
      assert.equal(await operations.evaluate('during native seal'), 'during native seal');
      assert.equal(steps.length, 1);
      releaseSealing();
      await completion;
      assert.equal(testInfo._tracing.stopIfNeeded(), completion);
      await testInfo._tracing.stopIfNeeded();
      assert.equal(fallbackChecks, 1);
      assert.equal(testInfo.attachments.filter(attachment => attachment.name === 'error-context').length, 1);
      assert.equal(testInfo.attachments.filter(attachment => attachment.name === 'error-context-error').length, 0);
      assert.equal(testInfo.attachments.filter(attachment => attachment.name === 'trace').length, 1);
      assert.equal((await libraries(testInfo)).length, 1);
      assert.equal(testInfo.errors.length, 1);
      assert.equal(testInfo.errors[0].message, 'original lifecycle failure');
      assert.equal(testInfo.status, 'failed');
    } finally {
      if (pendingClaim !== undefined) completeRunnerContextCreation(pendingClaim);
      releaseSealing();
      runnerGlobals.setCurrentTestInfo(undefined);
      await originalContext.close();
      await lateContext.close();
      await coordinator.dispose();
    }
  });
  await check('failed final preflight and hostile matcher diagnostics still release original failure-context ownership', async () => {
    for (const mode of ['accessor', 'preflight']) {
      const coordinator = new RunnerArtifactCoordinator();
      const lateContext = context();
      let pageReads = 0;
      lateContext.pages = () => { pageReads++; return [{}]; };
      let throwDiagnostic = mode === 'accessor';
      const originalError = Object.freeze({
        message: `original ${mode} failure`,
        get errorContext() {
          if (throwDiagnostic) throw Error('hostile matcher diagnostic getter');
          return undefined;
        },
      });
      const originalInfo = Object.assign(information({ off: true }), {
        status: 'failed', errors: [originalError], titlePath: ['coordinator', mode],
        file: join(directory, 'missing-source.ts'), line: 1, column: 1,
      });
      let originalStops = 0;
      originalInfo._tracing.stopIfNeeded = async () => { originalStops++; };
      if (mode === 'preflight') originalInfo._timeoutManager._running.runnable.type = 'beforeAll';
      let originalClaim;
      try {
        coordinator.start(originalInfo);
        await coordinator.ready();
        originalClaim = beginRunnerContextCreation();
        const completion = originalInfo._tracing.stopIfNeeded();
        await completion;
        assert.equal(originalInfo._tracing.stopIfNeeded(), completion);
        assert.equal(originalStops, 1);
        assert.equal(originalInfo.status, 'failed');
        assert.equal(originalInfo.errors[0], originalError);
        const diagnostics = originalInfo.attachments.filter(attachment => attachment.name === 'error-context-error');
        assert(diagnostics.length > 0);
        assert.match(diagnostics.map(attachment => attachment.body.toString()).join('\n'), mode === 'accessor' ? /hostile matcher diagnostic getter/ : /outside its separate timeout slot/);
        throwDiagnostic = false;
        const successorInfo = information({ off: true });
        let successorStops = 0;
        successorInfo._tracing.stopIfNeeded = async () => { successorStops++; };
        coordinator.start(successorInfo);
        await coordinator.ready();
        await publish(lateContext, originalClaim);
        originalClaim = undefined;
        await lateContext.close();
        await successorInfo._tracing.stopIfNeeded();
        assert.equal(pageReads, 0, 'a finalization failure cannot leave its old creation claim eligible for later fallback');
        assert.deepEqual(lateContext.calls, [], 'original trace-off creation never acquires a successor trace');
        assert.equal(successorStops, 1);
        assert.equal(successorInfo.attachments.length, 0);
        assert.equal(successorInfo.errors.length, 0);
      } finally {
        if (originalClaim !== undefined) completeRunnerContextCreation(originalClaim);
        await lateContext.close();
        await coordinator.dispose();
      }
    }
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { await rm(directory, { recursive: true, force: true }); console.log(JSON.stringify(report)); }
