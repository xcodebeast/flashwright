import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { Tracing } = require('../packages/flashwright-core/dist/commonjs/tracing.js');
const { runnerIntegration } = require('../packages/flashwright-core/dist/commonjs/runner-integration.js');
const directory = await mkdtemp(join(tmpdir(), 'flashwright-runner-archives-'));
const archives = [];
const report = { status: 'running', checks: [] };
const signal = () => new AbortController().signal;
const turn = () => new Promise(resolve => setImmediate(resolve));
const current = tracing => runnerIntegration.currentTraceChunk(3, tracing);
function deferred() { let resolve; const promise = new Promise(complete => { resolve = complete; }); return { promise, resolve }; }
async function check(name, callback) { await callback(); report.checks.push(name); }

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
}

async function fixture(callback, options = {}) {
  const driver = new RecordingDriver();
  const tracing = new Tracing(driver, 'original-context', null);
  const retained = [];
  try {
    await tracing.start(options);
    await callback({ driver, tracing, retained });
  } finally {
    tracing.ownerClosed();
    for (const archive of retained) await archive.dispose();
    await tracing.cleanup;
  }
}

/** Drive only the production preparation/grace deadlines, without waiting thirty seconds. */
async function withControlledDeadlines(callback) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  globalThis.setTimeout = (callback, milliseconds, ...arguments_) => {
    if (milliseconds !== 30000 && milliseconds !== 2000) return originalSetTimeout(callback, milliseconds, ...arguments_);
    const handle = {};
    timers.set(handle, { callback, milliseconds });
    return handle;
  };
  globalThis.clearTimeout = handle => {
    if (!timers.delete(handle)) originalClearTimeout(handle);
  };
  try {
    await callback(milliseconds => {
      const timer = [...timers.values()].find(timer => timer.milliseconds === milliseconds);
      assert.ok(timer, `Missing ${milliseconds}ms deadline`);
      timer.callback();
    });
  } finally { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; }
}

async function records(archive) {
  const reader = archive.acquire();
  try { return (await readFile(reader.entries.find(entry => entry.name === 'trace.trace').path, 'utf8')).trim().split('\n').map(JSON.parse); }
  finally { reader.release(); }
}

try {
  await check('version and owner validation have no recording side effects; off has no chunk handle', async () => {
    const driver = new RecordingDriver();
    const tracing = new Tracing(driver, 'context', null);
    assert.equal(runnerIntegration.version, 5);
    assert.throws(() => runnerIntegration.currentTraceChunk(2, tracing), { name: 'ProtocolError' });
    assert.throws(() => current({}), { name: 'ProtocolError' });
    assert.equal(current(tracing), undefined);
    assert.deepEqual(driver.calls, []);
    assert.equal(Object.hasOwn(require('../packages/flashwright-core/dist/commonjs/index.js'), 'runnerIntegration'), false);
    tracing.ownerClosed();
  });

  await check('handoff waits for original native retirement and retained chunks survive recording and context closure', async () => {
    await fixture(async ({ driver, tracing, retained }) => {
      const entered = deferred(); const released = deferred();
      const originalChunk = tracing.chunk.identifier;
      driver.intercept = async (method, parameters) => {
        if (method === 'context.trace.chunk.status' && parameters.chunk === originalChunk) { entered.resolve(); await released.promise; }
      };
      const resourceOwner = tracing.resources;
      const firstWriter = tracing.chunk.writer;
      firstWriter.append({ type: 'event', marker: 'first' });
      const handle = current(tracing);
      assert.equal(current(tracing), handle);
      assert.equal(Object.isFrozen(handle), true);
      let delivered = false;
      const taking = handle.takeArchive().then(archive => { delivered = true; retained.push(archive); return archive; });
      try {
        await entered.promise;
        assert.equal(delivered, false);
        assert.equal(current(tracing), undefined);
        await assert.rejects(tracing.startChunk(), /control operation is in progress/);
        released.resolve();
        const first = await taking;
        assert.equal(tracing.cleanup, undefined);
        assert.equal(tracing.recording, true);
        await tracing.startChunk();
        const successor = current(tracing);
        tracing.chunk.writer.append({ type: 'event', marker: 'second' });
        const callsBeforeStale = driver.calls.length;
        await assert.rejects(handle.takeArchive(), /original trace chunk is no longer current/);
        assert.equal(driver.calls.length, callsBeforeStale);
        assert.equal(current(tracing), successor);
        const second = await successor.takeArchive(); retained.push(second);
        await tracing.stop();
        tracing.ownerClosed(); await tracing.cleanup;
        await access(resourceOwner.directory);
        assert.deepEqual((await records(first)).filter(record => record.marker).map(record => record.marker), ['first']);
        assert.deepEqual((await records(second)).filter(record => record.marker).map(record => record.marker), ['second']);
        for (const [index, archive] of retained.entries()) {
          const path = join(directory, `retained-${index}.zip`);
          await archive.export(path, signal()); archives.push(path);
          await archive.dispose();
        }
        await assert.rejects(access(resourceOwner.directory), { code: 'ENOENT' });
        const chunkStarts = driver.calls.filter(call => call.method === 'context.trace.chunk.start');
        assert.equal(chunkStarts.length, 2);
        assert.equal(chunkStarts[0].parameters.recording, chunkStarts[1].parameters.recording);
      } finally { released.resolve(); await taking; }
    }, { snapshots: true });
  });

  await check('manual replacement and pre-aborted handoff leave the successor untouched', async () => {
    await fixture(async ({ driver, tracing, retained }) => {
      const original = current(tracing);
      await tracing.startChunk();
      const successor = current(tracing);
      const calls = driver.calls.length;
      await assert.rejects(original.takeArchive(), /original trace chunk is no longer current/);
      const cancellation = new AbortController(); const reason = Error('attempt already cancelled'); cancellation.abort(reason);
      await assert.rejects(successor.takeArchive(cancellation.signal), error => error === reason);
      assert.equal(driver.calls.length, calls);
      assert.equal(current(tracing), successor);
      retained.push(await successor.takeArchive());
      await assert.rejects(successor.takeArchive(), /original trace chunk is no longer current/);
    });
  });

  for (const cause of ['runner cancellation', 'owner closure', 'preparation deadline']) {
    await check(`${cause} retains late manifest disposal and blocks successors until preparation settles`, async () => {
      await withControlledDeadlines(async expire => {
        await fixture(async ({ tracing }) => {
          const writer = tracing.chunk.writer;
          const entered = deferred(); const released = deferred();
          const originalTake = writer.takeArchive.bind(writer);
          let lateArchive;
          writer.takeArchive = async cancellation => {
            lateArchive = await originalTake(cancellation);
            entered.resolve(); await released.promise;
            return lateArchive;
          };
          const cancellation = new AbortController();
          const reason = Error('original runner cancellation');
          const taking = current(tracing).takeArchive(cancellation.signal);
          const rejected = assert.rejects(taking, error => cause === 'runner cancellation' ? error === reason : error.name === (cause === 'owner closure' ? 'TargetClosedError' : 'TimeoutError'));
          try {
            await entered.promise;
            if (cause === 'runner cancellation') cancellation.abort(reason);
            else if (cause === 'owner closure') tracing.ownerClosed();
            else expire(30000);
            await turn(); expire(2000); await rejected;
            assert.ok(tracing.cleanup);
            await assert.rejects(tracing.startChunk(), { name: cause === 'owner closure' ? 'TargetClosedError' : 'ResourceLimitError' });
            await access(writer.directory);
            released.resolve(); await tracing.cleanup;
            assert.throws(() => lateArchive.acquire(), { name: 'TargetClosedError' });
            await assert.rejects(access(writer.directory), { code: 'ENOENT' });
            if (cause !== 'owner closure') { await tracing.startChunk(); await tracing.stop(); }
          } finally { released.resolve(); await rejected; await tracing.cleanup; }
        });
      });
    });
  }

  await check('cleanup failure after manifest preparation discards it and preserves the original failure', async () => {
    await fixture(async ({ tracing }) => {
      const writer = tracing.chunk.writer;
      const originalDispose = writer.dispose.bind(writer);
      const originalFailure = Error('writer cleanup failed');
      writer.dispose = async () => { await originalDispose(); throw originalFailure; };
      await assert.rejects(current(tracing).takeArchive(), error => error === originalFailure);
      await tracing.cleanup;
      await assert.rejects(access(writer.directory), { code: 'ENOENT' });
      await assert.rejects(tracing.startChunk(), error => error === originalFailure);
    });
  });

  await check('the preparation deadline still applies at custody transfer after final cleanup', async () => {
    await fixture(async ({ tracing }) => {
      const writer = tracing.chunk.writer;
      const originalDispose = writer.dispose.bind(writer);
      const originalClock = performance.now;
      const clockDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
      const entered = deferred(); const released = deferred();
      writer.dispose = async () => { entered.resolve(); await released.promise; return originalDispose(); };
      const rejected = assert.rejects(current(tracing).takeArchive(), { name: 'TimeoutError' });
      try {
        await entered.promise;
        Object.defineProperty(performance, 'now', { configurable: true, value: () => originalClock.call(performance) + 31000 });
        released.resolve(); await rejected; await tracing.cleanup;
        await assert.rejects(access(writer.directory), { code: 'ENOENT' });
      } finally {
        if (clockDescriptor) Object.defineProperty(performance, 'now', clockDescriptor);
        else delete performance.now;
        released.resolve(); await rejected;
      }
      await tracing.startChunk(); await tracing.stop();
    });
  });

  await check('unsettled cleanup cannot transfer an archive; late cleanup retains its original owner', async () => {
    await withControlledDeadlines(async expire => {
      await fixture(async ({ tracing }) => {
        const writer = tracing.chunk.writer;
        const originalDispose = writer.dispose.bind(writer);
        const entered = deferred(); const released = deferred();
        writer.dispose = async () => { entered.resolve(); await released.promise; return originalDispose(); };
        const taking = current(tracing).takeArchive();
        const rejected = assert.rejects(taking, /cleanup has not settled before archive handoff/);
        try {
          await entered.promise; expire(2000); await rejected;
          assert.ok(tracing.cleanup);
          await assert.rejects(tracing.startChunk(), { name: 'ResourceLimitError' });
          released.resolve(); await tracing.cleanup;
          await assert.rejects(access(writer.directory), { code: 'ENOENT' });
          await tracing.startChunk(); await tracing.stop();
        } finally { released.resolve(); await rejected; await tracing.cleanup; }
      });
    });
  });

  await check('owner closure while final cleanup is pending prevents handoff', async () => {
    await fixture(async ({ tracing }) => {
      const writer = tracing.chunk.writer;
      const originalDispose = writer.dispose.bind(writer);
      const entered = deferred(); const released = deferred();
      writer.dispose = async () => { entered.resolve(); await released.promise; return originalDispose(); };
      const rejected = assert.rejects(current(tracing).takeArchive(), { name: 'TargetClosedError' });
      try {
        await entered.promise; tracing.ownerClosed(); released.resolve(); await rejected; await tracing.cleanup;
        await assert.rejects(access(writer.directory), { code: 'ENOENT' });
      } finally { released.resolve(); await rejected; }
    });
  });

  await check('independent Python ZIP reader validates every retained archive checksum', async () => {
    execFileSync('python3', ['-c', 'import sys,zipfile\nfor path in sys.argv[1:]:\n with zipfile.ZipFile(path) as archive: assert archive.testzip() is None, path', ...archives]);
  });
  report.status = 'passed'; console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
