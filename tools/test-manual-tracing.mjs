import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { Tracing } = require('../packages/flashwright-core/dist/commonjs/tracing.js');
const { BrowserContext } = require('../packages/flashwright-core/dist/commonjs/index.js');
const { instrumentTraceMethods, instrumentTraceCallbacks, runTraceUserCallback, traceRecordingActive } = require('../packages/flashwright-core/dist/commonjs/trace-hooks.js');
const { tracePreview, serializedTracePreview, traceError } = require('../packages/flashwright-core/dist/commonjs/trace-preview.js');
const { TraceDiagnosticChannel } = require('../packages/flashwright-core/dist/commonjs/trace-diagnostics.js');
const { TraceWriter } = require('../packages/flashwright-core/dist/commonjs/trace-writer.js');
const { TraceResources } = require('../packages/flashwright-core/dist/commonjs/trace-resources.js');
const { utils, iso } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const directory = await mkdtemp(join(tmpdir(), 'flashwright-trace-tests-'));
const checks = [];
const verifiedArchives = new Set();
const deferred = () => { let resolve; const promise = new Promise(fulfill => { resolve = fulfill; }); return { promise, resolve }; };
async function check(name, callback) { await callback(); checks.push(name); }

class DiagnosticDriver {
  requests = [];
  generation;
  events = [];
  async request(method, parameters) {
    this.requests.push({ method, parameters });
    if (method === 'context.trace.start') { assert.equal(this.generation, undefined); this.generation = parameters.generation; return null; }
    assert.equal(parameters.generation, this.generation);
    const result = { generation: this.generation, events: this.events.splice(0) };
    if (method === 'context.trace.stop') this.generation = undefined;
    return result;
  }
}
class Operations {
  constructor(tracing) { this.tracing = tracing; }
  async outer(value) { return this.inner(value); }
  async inner(value) { return value; }
  async wait(promise) { return promise; }
  async eventWait(promise) { return promise; }
  async callback(callback) { return runTraceUserCallback(callback); }
  async reject(error) { throw error; }
}
instrumentTraceMethods(Operations.prototype, 'Page', owner => ({ tracing: owner.tracing, pageId: 'page' }), { outer: { parameters: ['value'] }, inner: { parameters: ['value'] }, wait: {}, eventWait: { completion: 'independent' }, callback: {}, reject: {} });

async function events(path) {
  verifiedArchives.add(path);
  const archive = new utils.ZipFile(path);
  try {
    const names = await archive.entries();
    assert.deepEqual(names, ['trace.trace', 'trace.network']);
    const loader = new iso.TraceLoader();
    await loader.load({ entryNames: async () => names, readText: async name => names.includes(name) ? (await archive.read(name)).toString() : undefined, hasEntry: async name => names.includes(name), isLive: () => false });
    const records = (await archive.read('trace.trace')).toString().trim().split('\n').map(JSON.parse);
    return { records, actions: loader.contextEntries[0].actions };
  } finally { archive.close(); }
}

try {
  await check('event delivery finishes before diagnostics while export retains and drains original completion', async () => {
    const driver = new DiagnosticDriver();
    const gate = deferred();
    const request = driver.request.bind(driver);
    driver.request = async (method, parameters) => {
      if (method === 'context.trace.pull') await gate.promise;
      return request(method, parameters);
    };
    const tracing = new Tracing(driver, 'context', null);
    const operations = new Operations(tracing);
    await tracing.start();
    assert.equal(await operations.eventWait(Promise.resolve(42)), 42);
    assert.equal(tracing.calls.size, 1);
    const path = join(directory, 'independent-event-completion.zip');
    let exported = false;
    const exportWork = tracing.stop({ path }).then(() => { exported = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(exported, false);
    gate.resolve(); await exportWork;
    const archive = await events(path);
    assert.equal(archive.actions.length, 1); assert.equal(archive.actions[0].method, 'eventWait');
    assert.ok(archive.actions[0].endTime > 0); assert.equal(tracing.calls.size, 0);
    assert.equal(traceRecordingActive(), false);
  });
  await check('callback can open a new chunk after its triggering call outlives the old chunk', async () => {
    class CallbackOperations extends EventEmitter {
      constructor(tracing) { super(); this.tracing = tracing; }
      async oldCall(promise) { await promise; this.emit('continue'); }
      async newCall() { return 42; }
    }
    instrumentTraceMethods(CallbackOperations.prototype, 'Page', owner => ({ tracing: owner.tracing, pageId: 'page' }), { oldCall: {}, newCall: {} });
    instrumentTraceCallbacks(CallbackOperations.prototype, 'emit');
    const tracing = new Tracing(new DiagnosticDriver(), 'context', null);
    const operations = new CallbackOperations(tracing);
    const gate = deferred();
    const oldPath = join(directory, 'retired-callback-old.zip');
    const newPath = join(directory, 'retired-callback-new.zip');
    let callbackWork;
    operations.once('continue', () => {
      callbackWork = (async () => {
        await tracing.startChunk();
        assert.equal(await operations.newCall(), 42);
        await tracing.stop({ path: newPath });
      })();
    });
    try {
      await tracing.start();
      const oldCall = operations.oldCall(gate.promise);
      await tracing.stopChunk({ path: oldPath });
      assert.equal(traceRecordingActive(), false);
      gate.resolve();
      await oldCall;
      await callbackWork;
      const oldEvents = await events(oldPath);
      const newEvents = await events(newPath);
      assert.deepEqual(oldEvents.records.filter(event => event.type === 'before').map(event => event.method), ['oldCall']);
      assert.equal(oldEvents.records.some(event => event.type === 'after'), false);
      assert.deepEqual(newEvents.records.filter(event => event.type === 'before').map(event => event.method), ['newCall']);
      assert.equal(newEvents.records.filter(event => event.type === 'after').length, 1);
    } finally { gate.resolve(); tracing.ownerClosed(); }
  });
  await check('previews avoid accessors, proxies, iterators and custom toJSON/toString', async () => {
    let sideEffects = 0;
    const proxy = new Proxy({}, { ownKeys() { sideEffects++; throw Error('ownKeys'); }, get() { sideEffects++; throw Error('get'); }, getPrototypeOf() { sideEffects++; throw Error('prototype'); }, getOwnPropertyDescriptor() { sideEffects++; throw Error('descriptor'); } });
    const object = { proxy, get value() { sideEffects++; return 1; }, toJSON() { sideEffects++; }, [Symbol.iterator]() { sideEffects++; } };
    const callable = () => 1;
    Object.defineProperty(callable, 'toString', { get() { sideEffects++; return () => 'bad'; } });
    object.callable = callable;
    const preview = tracePreview(object);
    assert.equal(sideEffects, 0);
    assert.equal(preview.proxy, '[Proxy]');
    assert.equal(preview.value, '[Accessor]');
    JSON.stringify(preview);
    assert.equal(sideEffects, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(tracePreview({ value: '\u0000'.repeat(100000) }))) < 32768);
  });
  await check('array and object Proxy prototypes are never traversed', async () => {
    let traps = 0;
    const prototype = new Proxy({}, { ownKeys() { traps++; return []; }, getOwnPropertyDescriptor() { traps++; return undefined; }, getPrototypeOf() { traps++; return null; }, get() { traps++; return undefined; } });
    const array = ['own value'];
    Object.setPrototypeOf(array, prototype);
    const preview = tracePreview(array);
    assert.equal(preview[0], 'own value');
    assert.equal(tracePreview(Object.create(prototype)), '[Object]');
    JSON.stringify(preview);
    assert.equal(traps, 0);
  });
  await check('inherited built-in error names are preserved without invoking getters', async () => {
    const original = new TypeError('typed callback failure');
    assert.equal(traceError(original).name, 'TypeError');
    let getters = 0;
    const custom = Object.create(new Proxy({}, { getOwnPropertyDescriptor() { getters++; throw Error('trap'); } }));
    assert.equal(traceError(custom).name, 'Error');
    assert.equal(getters, 0);
    assert.equal(original.name, 'TypeError');
    assert.equal(original.message, 'typed callback failure');
  });
  await check('evaluation previews use viewer-compatible serialized envelopes', async () => {
    assert.deepEqual(serializedTracePreview(undefined), { v: 'undefined' });
    assert.deepEqual(serializedTracePreview(-0), { v: '-0' });
    assert.deepEqual(serializedTracePreview({ special: [NaN, Infinity, -0] }), { o: [{ k: 'special', v: { a: [{ v: 'NaN' }, { v: 'Infinity' }, { v: '-0' }] } }] });
    assert.equal(tracePreview(NaN), '[Number NaN]');
    assert.deepEqual(serializedTracePreview({ value: [1, undefined] }), { o: [{ k: 'value', v: { a: [{ n: 1 }, { v: 'undefined' }] } }] });
  });
  await check('trace off preserves operation calls and never resolves trace ownership', async () => {
    class Untraced { action(value) { return value; } }
    instrumentTraceMethods(Untraced.prototype, 'Page', () => { throw Error('trace owner must not be consulted'); }, { action: {} });
    assert.equal(traceRecordingActive(), false);
    const value = {};
    assert.equal(new Untraced().action(value), value);
  });
  await check('invalid optional capture fails before native recording', async () => {
    for (const option of ['snapshots', 'screenshots', 'sources']) {
      const driver = new DiagnosticDriver();
      const tracing = new Tracing(driver, 'context', null);
      await assert.rejects(tracing.start({ [option]: 'true' }), { name: 'InvalidArgumentError' });
      assert.deepEqual(driver.requests, []);
    }
  });
  await check('failed start replies roll back diagnostic ownership in transport order', async () => {
    const driver = new DiagnosticDriver();
    const originalRequest = driver.request.bind(driver);
    const lostReply = Error('start acknowledgement lost');
    driver.request = async (method, parameters) => {
      const result = await originalRequest(method, parameters);
      if (method === 'context.trace.start') throw lostReply;
      return result;
    };
    const tracing = new Tracing(driver, 'context', null);
    await assert.rejects(tracing.start(), error => error === lostReply);
    assert.equal(driver.generation, undefined);
    assert.deepEqual(driver.requests.map(request => request.method), ['context.trace.start', 'context.trace.stop']);
    assert.equal(traceRecordingActive(), false);
  });
  await check('nested implementation calls merge while user callbacks create independent actions', async () => {
    const driver = new DiagnosticDriver();
    const tracing = new Tracing(driver, 'context', null);
    const operations = new Operations(tracing);
    await tracing.start();
    assert.equal(await operations.outer(7), 7);
    assert.equal(await operations.callback(() => operations.inner(9)), 9);
    const originalError = new Error('original');
    await assert.rejects(operations.reject(originalError), error => error === originalError);
    const path = join(directory, 'nested.zip');
    await tracing.stop({ path });
    const { actions } = await events(path);
    assert.deepEqual(actions.map(action => action.method), ['outer', 'callback', 'inner', 'reject']);
    assert.ok(actions.every(action => action.endTime > 0));
    assert.ok(actions[3].error.message.includes('original'));
    assert.equal(traceRecordingActive(), false);
  });
  await check('unfinished calls stay in their original chunk without fabricated completion', async () => {
    const driver = new DiagnosticDriver();
    const tracing = new Tracing(driver, 'context', null);
    const operations = new Operations(tracing);
    const pending = deferred();
    await tracing.start();
    const result = operations.wait(pending.promise);
    const firstPath = join(directory, 'first.zip');
    await tracing.stopChunk({ path: firstPath });
    await tracing.startChunk();
    pending.resolve(12);
    assert.equal(await result, 12);
    assert.equal(await operations.inner(13), 13);
    const secondPath = join(directory, 'second.zip');
    await tracing.stop({ path: secondPath });
    const first = await events(firstPath);
    const second = await events(secondPath);
    assert.equal(first.records.filter(event => event.type === 'before').length, 1);
    assert.equal(first.records.filter(event => event.type === 'after').length, 0);
    assert.deepEqual(second.actions.map(action => action.method), ['inner']);
  });
  await check('a fence arriving during an earlier pull gets a later acceptance fence', async () => {
    const driver = new DiagnosticDriver();
    const firstEntered = deferred();
    const firstReply = deferred();
    const originalRequest = driver.request.bind(driver);
    let pulls = 0;
    driver.request = async (method, parameters) => {
      if (method === 'context.trace.pull' && ++pulls === 1) { firstEntered.resolve(); await firstReply.promise; }
      return originalRequest(method, parameters);
    };
    const failures = [];
    const channel = await TraceDiagnosticChannel.start(driver, 'context', 'generation', () => {}, error => failures.push(error));
    const first = channel.fence();
    await firstEntered.promise;
    const second = channel.fence();
    firstReply.resolve();
    await Promise.all([first, second]);
    assert.equal(pulls, 2);
    await channel.stop();
    await channel.stop();
    assert.equal(driver.requests.filter(request => request.method === 'context.trace.stop').length, 1);
    assert.deepEqual(failures, []);
  });
  await check('diagnostic failure preserves original operation result and destination', async () => {
    const driver = new DiagnosticDriver();
    const tracing = new Tracing(driver, 'context', null);
    const operations = new Operations(tracing);
    await tracing.start();
    const originalRequest = driver.request.bind(driver);
    const captureError = Error('diagnostic limit');
    driver.request = (method, parameters) => method === 'context.trace.pull' ? Promise.reject(captureError) : originalRequest(method, parameters);
    assert.equal(await operations.inner(17), 17);
    const path = join(directory, 'preserved.zip');
    await writeFile(path, 'existing destination');
    await assert.rejects(tracing.stop({ path }), error => error === captureError);
    assert.equal(await readFile(path, 'utf8'), 'existing destination');
  });
  await check('closed context settles fences, discards recording and rejects later export', async () => {
    const driver = new DiagnosticDriver();
    const tracing = new Tracing(driver, 'context', null);
    await tracing.start();
    await tracing.beforeOwnerClose();
    tracing.ownerClosed();
    assert.equal(traceRecordingActive(), false);
    await assert.rejects(tracing.stop({ path: join(directory, 'closed.zip') }), { name: 'TargetClosedError' });
    await tracing.cleanup;
  });
  await check('first tracing access after context closure stays closed without native requests', async () => {
    const driver = new DiagnosticDriver();
    driver.subscribeObject = () => () => {};
    const context = new BrowserContext(driver, 'closed-context', {}, null, undefined);
    context.didClose();
    const tracing = context.tracing;
    assert.equal(context.tracing, tracing);
    for (const method of ['start', 'startChunk', 'stopChunk', 'stop']) await assert.rejects(tracing[method](), { name: 'TargetClosedError' });
    assert.deepEqual(driver.requests, []);
  });
  await check('console arguments within the native event bound are never silently dropped', async () => {
    const driver = new DiagnosticDriver();
    const tracing = new Tracing(driver, 'context', null);
    await tracing.start();
    driver.events.push({ page: 'page', kind: 'console-api', raw: JSON.stringify({ type: 'log', args: Array.from({ length: 150 }, (_, index) => ({ type: 'number', value: index })) }) });
    const path = join(directory, 'many-console-arguments.zip');
    await tracing.stop({ path });
    const consoleEvent = (await events(path)).records.find(event => event.type === 'console');
    assert.equal(consoleEvent.args.length, 150);
    assert.ok(consoleEvent.text.endsWith('148 149'));
  });
  await check('writer failures and cancellation preserve existing destinations', async () => {
    const path = join(directory, 'writer-preserved.zip');
    await writeFile(path, 'existing');
    const resources = await TraceResources.create();
    const writer = await TraceWriter.create(resources);
    writer.append({ type: 'before', huge: 'x'.repeat(300000) });
    await assert.rejects(writer.finish(path, new AbortController().signal), { name: 'ResourceLimitError' });
    await writer.dispose();
    assert.equal(await readFile(path, 'utf8'), 'existing');
    const cancelledWriter = await TraceWriter.create(resources);
    cancelledWriter.append({ type: 'context-options', version: 8 });
    const cancellation = new AbortController();
    cancellation.abort(Error('cancelled'));
    await assert.rejects(cancelledWriter.finish(path, cancellation.signal), /cancelled/);
    await cancelledWriter.dispose();
    await resources.dispose();
    assert.equal(await readFile(path, 'utf8'), 'existing');
    assert.ok(!(await readdir(directory)).some(name => name.endsWith('.tmp')));
  });
  await check('atomic commit awaits a definitive rename result and rejects overlapping controls', async () => {
    const filesystem = require('node:fs/promises');
    const originalRename = filesystem.rename;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const entered = deferred();
    const release = deferred();
    const deadlineHandle = {};
    let deadlineDisarmed = false;
    let deadlineCallback;
    globalThis.setTimeout = (callback, milliseconds, ...arguments_) => {
      if (milliseconds === 30000) { deadlineCallback = callback; return deadlineHandle; }
      return originalSetTimeout(callback, milliseconds, ...arguments_);
    };
    globalThis.clearTimeout = handle => {
      if (handle === deadlineHandle) deadlineDisarmed = true;
      else originalClearTimeout(handle);
    };
    filesystem.rename = async (...arguments_) => { entered.resolve(); await release.promise; return originalRename(...arguments_); };
    const driver = new DiagnosticDriver();
    const tracing = new Tracing(driver, 'context', null);
    const path = join(directory, 'commit.zip');
    try {
      await tracing.start();
      await writeFile(path, 'old destination');
      const stopping = tracing.stop({ path });
      await entered.promise;
      assert.equal(typeof deadlineCallback, 'function');
      assert.equal(deadlineDisarmed, true, 'deadline cannot falsely fail a dispatched commit');
      assert.equal(await readFile(path, 'utf8'), 'old destination');
      await assert.rejects(tracing.start(), /control operation is in progress/);
      release.resolve();
      await stopping;
      assert.equal((await events(path)).actions.length, 0);
    } finally {
      release.resolve();
      filesystem.rename = originalRename;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      tracing.ownerClosed();
    }
  });
  await check('late cleanup retains ownership and quarantines the next recording', async () => {
    const originalDispose = TraceWriter.prototype.dispose;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const entered = deferred();
    const release = deferred();
    const graceHandle = {};
    let expireGrace;
    globalThis.setTimeout = (callback, milliseconds, ...arguments_) => {
      if (milliseconds === 2000) { expireGrace = callback; return graceHandle; }
      return originalSetTimeout(callback, milliseconds, ...arguments_);
    };
    globalThis.clearTimeout = handle => { if (handle !== graceHandle) originalClearTimeout(handle); };
    TraceWriter.prototype.dispose = async function() { entered.resolve(); await release.promise; return originalDispose.call(this); };
    const tracing = new Tracing(new DiagnosticDriver(), 'context', null);
    try {
      await tracing.start();
      const stopping = tracing.stop();
      await entered.promise;
      assert.equal(typeof expireGrace, 'function');
      expireGrace();
      await stopping;
      await assert.rejects(tracing.start(), /cleanup has not settled/);
      release.resolve();
      await tracing.cleanup;
      TraceWriter.prototype.dispose = originalDispose;
      await tracing.start();
      await tracing.stop();
    } finally {
      release.resolve();
      TraceWriter.prototype.dispose = originalDispose;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      tracing.ownerClosed();
    }
  });
  await check('independent Python ZIP reader verifies every exported entry checksum', async () => {
    execFileSync('python3', ['-c', 'import sys,zipfile\nfor path in sys.argv[1:]:\n with zipfile.ZipFile(path) as archive: assert archive.testzip() is None, path', ...verifiedArchives]);
  });
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
