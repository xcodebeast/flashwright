'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.env.TEST_WORKER_INDEX !== undefined) install();
function install() {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.versions.bun, '1.4.2');
  const directory = process.env.FLASHWRIGHT_APPLICATION_DISPATCH_DIRECTORY;
  assert(path.isAbsolute(directory ?? ''));
  const prepared = JSON.parse(fs.readFileSync(path.join(directory, 'prepared.json'), 'utf8'));
  const root = prepared.workspaceDirectory;
  const commonPath = path.join(root, prepared.engine === 'playwright' ? 'node_modules/playwright/lib/common/index.js' : 'packages/flashwright-runner/dist/upstream/lib/common/index.js');
  const globalsPath = path.join(path.dirname(commonPath), '../globals.js');
  const common = require(commonPath); const globals = require(globalsPath);
  const marker = Symbol.for('flashwright.application-dispatch.diagnostic.v1');
  assert.equal(common.test.Suite.prototype[marker], undefined, 'Observer installed more than once');
  common.test.Suite.prototype[marker] = directory;
  const clock = JSON.parse(process.env.FLASHWRIGHT_CAPTURE_CLOCK);
  assert.equal(clock.type, 'monotonic'); assert.equal(clock.implementation, 'clock_gettime(CLOCK_MONOTONIC)');
  assert.match(clock.identity, /^[a-f0-9]{32}$/);
  const { dlopen, ptr } = require('bun:ffi');
  const library = dlopen('libc.so.6', { clock_gettime: { args: ['i32', 'ptr'], returns: 'i32' }, clock_getres: { args: ['i32', 'ptr'], returns: 'i32' } });
  const timespec = new BigInt64Array(2);
  const readTimespec = () => { const [seconds, nanoseconds] = timespec; assert(seconds >= 0n && nanoseconds >= 0n && nanoseconds < 1000000000n); return seconds * 1000000000n + nanoseconds; };
  assert.equal(library.symbols.clock_getres(1, ptr(timespec)), 0); assert.equal(Number(readTimespec()) / 1e9, clock.resolutionSeconds);
  let previous = BigInt(clock.originNanoseconds);
  function now() { assert.equal(library.symbols.clock_gettime(1, ptr(timespec)), 0); const value = readTimespec(); assert(value >= previous); previous = value; return String(value); }
  const workerIndex = Number(process.env.TEST_WORKER_INDEX), parallelIndex = Number(process.env.TEST_PARALLEL_INDEX);
  assert(Number.isInteger(workerIndex) && workerIndex >= 0); assert(Number.isInteger(parallelIndex) && parallelIndex >= 0 && parallelIndex < prepared.workers);
  const stat = fs.readFileSync('/proc/self/stat', 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const processIdentity = `${clock.identity}/${process.pid}/${fields[19]}`;
  const fd = fs.openSync(path.join(directory, 'dispatch', `${process.pid}-${workerIndex}.jsonl`), 'wx');
  let sequence = 0, totalBytes = 0, closed = false;
  function record(kind, data = {}) {
    assert(!closed); const bytes = Buffer.from(JSON.stringify({ sequence: ++sequence, kind, nanoseconds: now(), ...data }) + '\n');
    totalBytes += bytes.length; assert(totalBytes <= 1024 * 1024, 'Worker journal limit exceeded');
    let offset = 0; while (offset < bytes.length) { const written = fs.writeSync(fd, bytes, offset); assert(written > 0); offset += written; }
  }
  record('worker-enrolled', { processIdentity, process: process.pid, parent: process.ppid, processStartTicks: fields[19], workerIndex, parallelIndex,
    clock, preparedSha256: digest(fs.readFileSync(path.join(directory, 'prepared.json'))), commonSha256: digest(fs.readFileSync(commonPath)),
    observerSha256: digest(fs.readFileSync(__filename)), executable: fs.readlinkSync('/proc/self/exe') });
  const wrapped = new WeakSet(); const contexts = new WeakMap(); let contextSequence = 0, registrationSequence = 0;
  const originalAdd = common.test.Suite.prototype._addTest;
  common.test.Suite.prototype._addTest = function(testCase) {
    if (globals.currentlyLoadingFileSuite() && !wrapped.has(testCase.fn)) {
      const target = testCase.fn; assert.equal(typeof target, 'function');
      const location = testCase.location;
      const relative = path.relative(prepared.project, location.file).split(path.sep).join('/');
      const source = prepared.generatedSources.find(source => source.path === relative); assert(source, 'Unbound callback source');
      const body = source.testBodies.find(body => body.title === testCase.title && body.line === location.line); assert(body, 'Unbound original callback declaration');
      assert.equal(digest(fs.readFileSync(location.file)), prepared.generatedHashes[relative]);
      const registration = ++registrationSequence;
      const runtimeText = Function.prototype.toString.call(target);
      const identity = { registration, file: relative, line: location.line, column: location.column, title: testCase.title,
        sourceBodySha256: body.sha256, runtimeFunctionSha256: digest(runtimeText) };
      record('callback-registered', { ...identity, runtimeFunctionText: runtimeText });
      const stringify = () => runtimeText;
      let proxy;
      proxy = new Proxy(target, {
        get(fn, key, receiver) { return key === 'toString' ? stringify : Reflect.get(fn, key, receiver); },
        async apply(fn, receiver, args) {
          const [fixtures, info] = args;
          assert.equal(info.fn, proxy); assert.equal(info.file, location.file); assert.equal(info.line, location.line);
          assert.equal(info.title, testCase.title); assert.equal(info.workerIndex, workerIndex); assert.equal(info.parallelIndex, parallelIndex);
          assert.equal(info.retry, 0); assert.equal(digest(Function.prototype.toString.call(fn)), identity.runtimeFunctionSha256);
          assert(fixtures.page && typeof fixtures.page.context === 'function', 'Original corpus callback must already request page');
          const context = fixtures.page.context(); let contextIdentity = contexts.get(context);
          if (!contextIdentity) {
            contextIdentity = `${processIdentity}/context/${++contextSequence}`; contexts.set(context, contextIdentity);
            record('context-first-observed', { contextIdentity });
            context.once('close', () => record('context-closed', { contextIdentity }));
          }
          const attempt = { ...identity, testId: info.testId, retry: info.retry, workerIndex, parallelIndex, contextIdentity };
          record('callback-entered', attempt);
          let value;
          try { value = await Reflect.apply(fn, receiver, args); }
          catch (error) { record('callback-returned', { ...attempt, outcome: 'rejected' }); throw error; }
          record('callback-returned', { ...attempt, outcome: 'resolved' }); return value;
        },
      });
      wrapped.add(proxy); testCase.fn = proxy;
    }
    return Reflect.apply(originalAdd, this, [testCase]);
  };
  const originalDispatch = common.ProcessRunner.prototype.dispatchEvent;
  common.ProcessRunner.prototype.dispatchEvent = function(method, params) {
    if (method === 'testBegin' || method === 'testEnd') record(method === 'testBegin' ? 'attempt-begin-dispatched' : 'attempt-end-dispatched',
      { testId: params.testId, ...(method === 'testEnd' ? { status: params.status, duration: params.duration } : {}) });
    return Reflect.apply(originalDispatch, this, [method, params]);
  };
  process.once('exit', code => { record('worker-exit-hook', { code }); fs.fsyncSync(fd); fs.closeSync(fd); closed = true; library.close(); });
}
