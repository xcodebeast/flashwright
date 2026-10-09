import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { installRunnerTraceFinalizer } = require('../packages/flashwright-runner/dist/commonjs/runner-trace-finalizer.js');
const { runnerIntegration } = require('../packages/flashwright-core/dist/commonjs/runner-integration.js');
const directory = await filesystem.mkdtemp(join(tmpdir(), 'flashwright-final-stop-'));
const report = { status: 'running', checks: [] };
const archives = [];
const attemptInformation = [];
let nextAttempt = 0;
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; let reject; const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; }); return { promise, resolve, reject }; };
async function check(name, callback) { await callback(); report.checks.push(name); }

function information(abandon = false, failed = false) {
  const mainSlot = { timeout: 4567, elapsed: 123 };
  const finalSlot = { timeout: 2000, elapsed: 0 };
  const destination = join(directory, `attempt-${++nextAttempt}.zip`);
  const attachments = []; const published = [];
  const snapshot = attachment => ({ ...attachment, ...(attachment.body ? { body: attachment.body.toString('base64') } : {}) });
  Object.defineProperty(attachments, 'push', { configurable: true, value: (...values) => { published.push(...values.map(snapshot)); return Array.prototype.push.apply(attachments, values); } });
  const information = {
    timeout: 4567, status: failed ? 'failed' : 'passed', expectedStatus: failed ? 'failed' : 'passed',
    errors: failed ? [{ message: 'original expected failure' }] : [], attachments,
    outputPath: name => { assert.equal(name, 'trace.zip'); return destination; },
    _timeoutManager: { _running: { slot: finalSlot, runnable: { type: 'test', slot: finalSlot } }, defaultSlot: () => mainSlot, setTimeout(value) { this._running.slot.timeout = value; } },
    _tracing: { _shouldAbandonTrace: () => abandon, stopIfNeeded() { throw Error('original finalizer must not run'); } },
  };
  attemptInformation.push({ information, published, snapshot });
  return information;
}

function journal() {
  const owner = runnerIntegration.beginTraceJournal(6, { type: 'context-options', version: 8, origin: 'testRunner', monotonicTime: 10, wallTime: 20, options: {} }, { attachments: true, sources: false });
  owner.append({ type: 'stdout', timestamp: 11, text: 'original attempt' });
  return owner;
}

function diagnostics(testInfo) { return testInfo.attachments.find(attachment => attachment.name === 'trace-error')?.body.toString(); }
function outcome(testInfo) { return { status: testInfo.status, expectedStatus: testInfo.expectedStatus, timeout: testInfo.timeout, errors: structuredClone(testInfo.errors), mainSlot: { ...testInfo._timeoutManager.defaultSlot() } }; }

/** Drive the real preparation and foreground-grace timers without waiting thirty seconds. */
async function controlledTimers(callback) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  globalThis.setTimeout = (callback, milliseconds, ...arguments_) => {
    if (![30000, 2000].includes(milliseconds)) return originalSetTimeout(callback, milliseconds, ...arguments_);
    const handle = {}; timers.set(handle, { callback, milliseconds }); return handle;
  };
  globalThis.clearTimeout = handle => { if (!timers.delete(handle)) originalClearTimeout(handle); };
  try {
    await callback({
      has: milliseconds => [...timers.values()].some(timer => timer.milliseconds === milliseconds),
      fire: milliseconds => {
        const entry = [...timers.entries()].find(([, timer]) => timer.milliseconds === milliseconds);
        assert.ok(entry, `missing ${milliseconds}ms timer`);
        timers.delete(entry[0]); entry[1].callback();
      },
    });
  } finally { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; }
}

try {
  await check('final stop is idempotent and preserves original outcomes and the main timeout slot', async () => {
    for (const failed of [false, true]) {
      const testInfo = information(false, failed); const original = outcome(testInfo); const owner = journal(); const admission = { journal: owner };
      const originalPush = testInfo.attachments.push;
      testInfo._tracing.appendBeforeActionForStep = () => owner.append({ type: 'before', callId: 'artifact' });
      testInfo._tracing.appendAfterActionForStep = () => owner.append({ type: 'after', callId: 'artifact' });
      Object.defineProperty(testInfo.attachments, 'push', { value: (...attachments) => {
        testInfo._tracing.appendBeforeActionForStep(); testInfo._tracing.appendAfterActionForStep();
        return originalPush(...attachments);
      } });
      const finalizer = installRunnerTraceFinalizer(testInfo, admission);
      assert.equal(installRunnerTraceFinalizer(testInfo, admission), finalizer);
      assert.throws(() => installRunnerTraceFinalizer(testInfo, { journal: owner }), { name: 'ProtocolError' });
      const first = testInfo._tracing.stopIfNeeded(); assert.equal(first, finalizer.finish()); await first; await finalizer.cleanup;
      assert.deepEqual(outcome(testInfo), original); assert.equal(testInfo._timeoutManager._running.slot.timeout, 0);
      assert.equal(testInfo.attachments.length, 1); assert.equal(testInfo.attachments[0].name, 'trace');
      assert.equal(owner.failure, undefined, 'final attachment steps cannot reenter their sealed journal');
      archives.push(testInfo.attachments[0].path); await assert.rejects(filesystem.access(owner.directory), { code: 'ENOENT' });
    }
  });

  await check('abandoned attempts dispose their journal without reading final file resources', async () => {
    const testInfo = information(true); let disposed = 0;
    const owner = { takeArchive: () => { throw Error('abandoned trace must not prepare resources'); }, dispose: async () => { disposed++; } };
    const finalizer = installRunnerTraceFinalizer(testInfo, { journal: owner, failure: Error('discarded capture failure') });
    await finalizer.finish(); await finalizer.cleanup;
    assert.equal(disposed, 1); assert.deepEqual(testInfo.attachments, []);
  });

  await check('an unexpected final boundary cannot modify the default test timeout', async () => {
    const testInfo = information(); const original = outcome(testInfo); const owner = journal();
    testInfo._timeoutManager._running.slot = testInfo._timeoutManager.defaultSlot();
    testInfo._timeoutManager._running.runnable.slot = testInfo._timeoutManager.defaultSlot();
    const finalizer = installRunnerTraceFinalizer(testInfo, { journal: owner }); await finalizer.finish(); await finalizer.cleanup;
    assert.deepEqual(outcome(testInfo), original); assert.match(diagnostics(testInfo), /separate timeout slot/);
  });

  await check('preparation deadline retains late archive and cleanup custody after the foreground grace', async () => {
    await controlledTimers(async timers => {
      const testInfo = information(false, true); const original = outcome(testInfo);
      const prepared = deferred(); const releaseCleanup = deferred(); let disposed = 0; let archiveDisposed = 0; let signal;
      const owner = { takeArchive: async (_timeout, originalSignal) => { signal = originalSignal; return prepared.promise; }, dispose: async () => { disposed++; await releaseCleanup.promise; } };
      const finalizer = installRunnerTraceFinalizer(testInfo, { journal: owner });
      const completion = finalizer.finish(); timers.fire(30000); await turn();
      assert.equal(signal.aborted, true); assert.equal(disposed, 1); timers.fire(2000); await completion;
      let cleaned = false; void finalizer.cleanup.then(() => { cleaned = true; }); await turn(); assert.equal(cleaned, false);
      assert.match(diagnostics(testInfo), /30 seconds/); assert.match(diagnostics(testInfo), /cleanup remains pending/);
      const successor = information(); const successorFinalizer = installRunnerTraceFinalizer(successor, { journal: journal() });
      await successorFinalizer.finish(); await successorFinalizer.cleanup; archives.push(successor.attachments[0].path);
      prepared.resolve({ export: async () => { throw Error('late archive must never export'); }, dispose: async () => { archiveDisposed++; } });
      releaseCleanup.resolve(); await finalizer.cleanup;
      assert.equal(archiveDisposed, 1); assert.deepEqual(outcome(testInfo), original);
      assert.equal(testInfo.attachments.some(attachment => attachment.name === 'trace'), false);
    });
  });

  await check('monotonic deadline is rechecked after preparation even before the timer callback runs', async () => {
    await controlledTimers(async () => {
      const testInfo = information(); const prepared = deferred(); let exported = false; let disposed = 0;
      const finalizer = installRunnerTraceFinalizer(testInfo, { journal: { takeArchive: () => prepared.promise, dispose: async () => {} } });
      const completion = finalizer.finish(); const originalDescriptor = Object.getOwnPropertyDescriptor(performance, 'now'); const originalNow = performance.now.bind(performance);
      try {
        Object.defineProperty(performance, 'now', { configurable: true, value: () => originalNow() + 31000 });
        prepared.resolve({ export: async () => { exported = true; }, dispose: async () => { disposed++; } });
        await completion; await finalizer.cleanup;
      } finally { if (originalDescriptor) Object.defineProperty(performance, 'now', originalDescriptor); else delete performance.now; }
      assert.equal(exported, false); assert.equal(disposed, 1); assert.match(diagnostics(testInfo), /30 seconds/);
    });
  });

  await check('dispatched atomic rename awaits its definitive success or failure past preparation time', async () => {
    for (const failRename of [false, true]) await controlledTimers(async timers => {
      const testInfo = information(); const original = outcome(testInfo); const destination = testInfo.outputPath('trace.zip');
      await filesystem.writeFile(destination, 'previous destination');
      const entered = deferred(); const release = deferred(); const originalRename = filesystem.rename;
      filesystem.rename = async (source, target) => { assert.equal(target, destination); entered.resolve(); await release.promise; if (failRename) throw Error('original rename failure'); await originalRename(source, target); };
      const originalDescriptor = Object.getOwnPropertyDescriptor(performance, 'now'); const originalNow = performance.now.bind(performance);
      try {
        const finalizer = installRunnerTraceFinalizer(testInfo, { journal: journal() }); let complete = false;
        const completion = finalizer.finish().then(() => { complete = true; }); await entered.promise;
        assert.equal(timers.has(30000), false);
        Object.defineProperty(performance, 'now', { configurable: true, value: () => originalNow() + 31000 });
        await turn(); assert.equal(complete, false); assert.equal(await filesystem.readFile(destination, 'utf8'), 'previous destination');
        release.resolve(); await completion; await finalizer.cleanup;
        assert.deepEqual(outcome(testInfo), original);
        if (failRename) { assert.equal(await filesystem.readFile(destination, 'utf8'), 'previous destination'); assert.match(diagnostics(testInfo), /original rename failure/); }
        else { assert.equal(testInfo.attachments[0].name, 'trace'); archives.push(destination); }
        assert.equal((await filesystem.readdir(directory)).some(name => name.endsWith('.tmp')), false);
      } finally { release.resolve(); filesystem.rename = originalRename; if (originalDescriptor) Object.defineProperty(performance, 'now', originalDescriptor); else delete performance.now; }
    });
  });

  await check('artifact and cleanup failures remain bounded diagnostics without executing error hooks', async () => {
    const testInfo = information(false, true); const original = outcome(testInfo); let invoked = 0;
    const error = {};
    for (const name of ['message', 'stack']) Object.defineProperty(error, name, { get() { invoked++; throw Error('error getter'); } });
    const finalizer = installRunnerTraceFinalizer(testInfo, { failure: error, journal: { dispose: async () => { throw 'x'.repeat(1024 * 1024); } } });
    await finalizer.finish(); await finalizer.cleanup;
    assert.equal(invoked, 0); assert.deepEqual(outcome(testInfo), original); assert.equal(testInfo.attachments.length, 1);
    assert.ok(diagnostics(testInfo).length < 8192); assert.match(diagnostics(testInfo), /non-data error/);
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { invoked++; throw Error('proxy descriptor'); } });
    const successor = information(); const proxyFinalizer = installRunnerTraceFinalizer(successor, { failure: proxy });
    await proxyFinalizer.finish(); assert.equal(invoked, 0); assert.match(diagnostics(successor), /non-data error/);
  });

  await check('every retained real archive has independently valid ZIP CRCs and original final timeout', async () => {
    for (const { information, published, snapshot } of attemptInformation) assert.deepEqual(information.attachments.map(snapshot), published, 'reporter receives final attachment bytes at insertion');
    execFileSync('python3', ['-c', 'import sys,zipfile,json\nfor path in sys.argv[1:]:\n with zipfile.ZipFile(path) as archive:\n  assert archive.testzip() is None\n  assert json.loads(archive.read("test.trace").splitlines()[0])["testTimeout"]==4567', ...archives]);
  });
  report.status = 'passed'; report.archives = archives.length; console.log(JSON.stringify(report, null, 2));
} finally { await filesystem.rm(directory, { recursive: true, force: true }); }
