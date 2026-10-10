import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { installRunnerTraceFinalizer } = require('../packages/flashwright-runner/dist/commonjs/runner-trace-finalizer.js');
const { runnerIntegration } = require('../packages/flashwright-core/dist/commonjs/runner-integration.js');
const { SealedTraceArchive } = require('../packages/flashwright-core/dist/commonjs/trace-archive.js');
const directory = await filesystem.mkdtemp(join(tmpdir(), 'flashwright-final-stop-'));
const report = { status: 'running', checks: [] };
const archives = [];
const attemptInformation = [];
let nextAttempt = 0;
let nextInput = 0;
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

async function inputArchive(name = 'trace.trace', onDispose = () => {}) {
  const path = join(directory, `input-${++nextInput}`);
  const contents = Buffer.from(JSON.stringify({ type: 'context-options', version: 8, origin: 'library', contextId: `original-${nextInput}` }) + '\n');
  await filesystem.writeFile(path, contents);
  return new SealedTraceArchive([{ name, path, byteLength: contents.length, contentHash: createHash('sha256').update(contents).digest('hex') }], async () => {
    await filesystem.rm(path); onDispose();
  });
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
      assert.equal(finalizer.cleanupSucceeded, false);
      assert.equal(installRunnerTraceFinalizer(testInfo, admission), finalizer);
      assert.throws(() => installRunnerTraceFinalizer(testInfo, { journal: owner }), { name: 'ProtocolError' });
      const first = testInfo._tracing.stopIfNeeded(); assert.equal(first, finalizer.finish()); await first; await finalizer.cleanup;
      assert.equal(finalizer.cleanupSucceeded, true);
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
      assert.equal(finalizer.cleanupSucceeded, false);
      assert.match(diagnostics(testInfo), /30 seconds/); assert.match(diagnostics(testInfo), /cleanup remains pending/);
      const successor = information(); const successorFinalizer = installRunnerTraceFinalizer(successor, { journal: journal() });
      await successorFinalizer.finish(); await successorFinalizer.cleanup; archives.push(successor.attachments[0].path);
      prepared.resolve({ export: async () => { throw Error('late archive must never export'); }, dispose: async () => { archiveDisposed++; } });
      releaseCleanup.resolve(); await finalizer.cleanup;
      assert.equal(finalizer.cleanupSucceeded, true);
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

  await check('the original collection closes once and hands ordered library streams to the final journal assembly', async () => {
    const testInfo = information(); const original = outcome(testInfo); const owner = journal(); const admission = { journal: owner };
    let closed = 0; let disposed = 0; let inputDisposals = 0;
    const inputs = [await inputArchive('trace.trace', () => { inputDisposals++; }), await inputArchive('trace.trace', () => { inputDisposals++; })];
    const collection = {
      closeAdmission() { closed++; },
      async collect(acceptArchive, signal) { assert.equal(closed, 1); signal.throwIfAborted(); for (const input of inputs) acceptArchive(input); },
      async dispose() { disposed++; },
    };
    const finalizer = installRunnerTraceFinalizer(testInfo, admission, collection);
    assert.equal(installRunnerTraceFinalizer(testInfo, admission, collection), finalizer);
    assert.throws(() => installRunnerTraceFinalizer(testInfo, admission), { name: 'ProtocolError' });
    assert.throws(() => installRunnerTraceFinalizer(testInfo, admission, { ...collection }), { name: 'ProtocolError' });
    const completion = finalizer.finish(); assert.equal(closed, 1); assert.equal(finalizer.finish(), completion);
    await completion; await finalizer.cleanup;
    assert.equal(disposed, 1); assert.equal(inputDisposals, 2); assert.deepEqual(outcome(testInfo), original);
    assert.equal(diagnostics(testInfo), undefined); const destination = testInfo.attachments[0].path; archives.push(destination);
    execFileSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as archive:\n assert archive.namelist()==["0-trace.trace","1-trace.trace","test.trace"]\n assert archive.read("0-trace.trace")!=archive.read("1-trace.trace")', destination]);
  });

  await check('abandonment closes capture and settles every owner without collection or final resource reads', async () => {
    const testInfo = information(true); let closed = 0; let collectionDisposed = 0; let journalDisposed = 0;
    const finalizer = installRunnerTraceFinalizer(testInfo, { failure: Error('discarded admission failure'), journal: {
      takeArchive() { throw Error('abandoned source reads'); }, dispose() { journalDisposed++; },
    } }, {
      closeAdmission() { closed++; }, collect() { throw Error('abandoned collection'); }, dispose() { collectionDisposed++; },
    });
    await finalizer.finish(); await finalizer.cleanup;
    assert.equal(closed, 1); assert.equal(collectionDisposed, 1); assert.equal(journalDisposed, 1); assert.deepEqual(testInfo.attachments, []);
  });

  await check('failed runner admission preserves cleanup of both accepted libraries and the rejected journal', async () => {
    const testInfo = information(false, true); const original = outcome(testInfo); let inputDisposals = 0; let journalDisposed = 0; let collectionDisposed = 0;
    const library = await inputArchive('trace.trace', () => { inputDisposals++; });
    const wrongJournal = await inputArchive('trace.trace', () => { inputDisposals++; });
    const destination = testInfo.outputPath('trace.zip'); await filesystem.writeFile(destination, 'previous destination');
    const finalizer = installRunnerTraceFinalizer(testInfo, { journal: {
      async takeArchive() { return wrongJournal; }, dispose() { journalDisposed++; throw Error('synchronous journal cleanup failure'); },
    } }, {
      closeAdmission() {}, async collect(acceptArchive) { acceptArchive(library); }, dispose() { collectionDisposed++; throw Error('synchronous collection cleanup failure'); },
    });
    await finalizer.finish(); await finalizer.cleanup;
    assert.equal(inputDisposals, 2); assert.equal(journalDisposed, 1); assert.equal(collectionDisposed, 1); assert.deepEqual(outcome(testInfo), original);
    assert.equal(finalizer.cleanupSucceeded, false);
    assert.equal(await filesystem.readFile(destination, 'utf8'), 'previous destination');
    assert.match(diagnostics(testInfo), /outside its original archive role/);
    assert.match(diagnostics(testInfo), /synchronous journal cleanup failure/); assert.match(diagnostics(testInfo), /synchronous collection cleanup failure/);
  });

  await check('a partial collection failure disposes accepted inputs without preparing the runner journal', async () => {
    const testInfo = information(); let inputDisposals = 0; let journalDisposed = 0; let collectionDisposed = 0;
    const input = await inputArchive('trace.trace', () => { inputDisposals++; });
    const finalizer = installRunnerTraceFinalizer(testInfo, { journal: {
      takeArchive() { throw Error('journal must not read after collection failure'); }, async dispose() { journalDisposed++; },
    } }, {
      closeAdmission() {}, async collect(acceptArchive) { acceptArchive(input); throw Error('original collection failure'); }, async dispose() { collectionDisposed++; },
    });
    await finalizer.finish(); await finalizer.cleanup;
    assert.equal(inputDisposals, 1); assert.equal(journalDisposed, 1); assert.equal(collectionDisposed, 1);
    assert.match(diagnostics(testInfo), /original collection failure/); assert.doesNotMatch(diagnostics(testInfo), /journal must not read/);
  });

  await check('admission-close failure still disposes collection and journal without changing the test', async () => {
    const testInfo = information(false, true); const original = outcome(testInfo); let collectionDisposed = 0; let journalDisposed = 0;
    const finalizer = installRunnerTraceFinalizer(testInfo, { journal: {
      takeArchive() { throw Error('unexpected journal preparation'); }, dispose() { journalDisposed++; },
    } }, {
      closeAdmission() { throw Error('original admission-close failure'); }, collect() { throw Error('unexpected collection'); }, dispose() { collectionDisposed++; },
    });
    await finalizer.finish(); await finalizer.cleanup;
    assert.equal(collectionDisposed, 1); assert.equal(journalDisposed, 1); assert.deepEqual(outcome(testInfo), original);
    assert.match(diagnostics(testInfo), /original admission-close failure/);
  });

  await check('timed-out collection rejects late handoff and retains its original cleanup beyond a healthy successor', async () => {
    await controlledTimers(async timers => {
      const testInfo = information(false, true); const original = outcome(testInfo); let inputDisposals = 0; let originalSignal; let lateError;
      const release = deferred(); const collected = deferred(); const firstDisposed = deferred();
      const first = await inputArchive('trace.trace', () => { inputDisposals++; firstDisposed.resolve(); });
      const late = await inputArchive('trace.trace', () => { inputDisposals++; });
      const finalizer = installRunnerTraceFinalizer(testInfo, { journal: {
        takeArchive() { throw Error('expired collection must not prepare sources'); }, async dispose() {},
      } }, {
        closeAdmission() {},
        async collect(acceptArchive, signal) {
          originalSignal = signal; acceptArchive(first); await release.promise;
          try { acceptArchive(late); } catch (error) { lateError = error; throw error; } finally { collected.resolve(); }
        },
        async dispose() { await collected.promise; await late.dispose(); },
      });
      const completion = finalizer.finish(); timers.fire(30000); await firstDisposed.promise;
      assert.equal(originalSignal.aborted, true); timers.fire(2000); await completion;
      let cleaned = false; void finalizer.cleanup.then(() => { cleaned = true; }); await turn(); assert.equal(cleaned, false);
      const successor = information(); const successorFinalizer = installRunnerTraceFinalizer(successor, { journal: journal() });
      await successorFinalizer.finish(); await successorFinalizer.cleanup; archives.push(successor.attachments[0].path);
      release.resolve(); await finalizer.cleanup;
      assert.equal(lateError, originalSignal.reason); assert.equal(inputDisposals, 2); assert.deepEqual(outcome(testInfo), original);
      assert.match(diagnostics(testInfo), /30 seconds/); assert.match(diagnostics(testInfo), /cleanup remains pending/);
      assert.equal(testInfo.attachments.some(attachment => attachment.name === 'trace'), false);
    });
  });

  await check('a journal arriving after collection timeout keeps its own unadmitted archive custody', async () => {
    await controlledTimers(async timers => {
      const testInfo = information(); let inputDisposals = 0;
      const entered = deferred(); const prepared = deferred(); const firstDisposed = deferred();
      const library = await inputArchive('trace.trace', () => { inputDisposals++; firstDisposed.resolve(); });
      const lateJournal = await inputArchive('test.trace', () => { inputDisposals++; });
      const finalizer = installRunnerTraceFinalizer(testInfo, { journal: {
        async takeArchive() { entered.resolve(); return prepared.promise; }, async dispose() {},
      } }, { closeAdmission() {}, async collect(acceptArchive) { acceptArchive(library); }, async dispose() {} });
      const completion = finalizer.finish(); await entered.promise; timers.fire(30000); await firstDisposed.promise; timers.fire(2000); await completion;
      assert.equal(inputDisposals, 1); prepared.resolve(lateJournal); await finalizer.cleanup;
      assert.equal(inputDisposals, 2); assert.equal(testInfo.attachments.some(attachment => attachment.name === 'trace'), false);
      assert.match(diagnostics(testInfo), /30 seconds/);
    });
  });

  await check('every retained real archive has independently valid ZIP CRCs and original final timeout', async () => {
    for (const { information, published, snapshot } of attemptInformation) assert.deepEqual(information.attachments.map(snapshot), published, 'reporter receives final attachment bytes at insertion');
    execFileSync('python3', ['-c', 'import sys,zipfile,json\nfor path in sys.argv[1:]:\n with zipfile.ZipFile(path) as archive:\n  assert archive.testzip() is None\n  assert json.loads(archive.read("test.trace").splitlines()[0])["testTimeout"]==4567', ...archives]);
  });
  report.status = 'passed'; report.archives = archives.length; console.log(JSON.stringify(report, null, 2));
} finally { await filesystem.rm(directory, { recursive: true, force: true }); }
