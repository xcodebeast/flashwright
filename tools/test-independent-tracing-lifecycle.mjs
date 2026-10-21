import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { FixturePool } from '../packages/flashwright-runner/dist/commonjs/independent/fixture-pool.js';
import { SuiteCollector } from '../packages/flashwright-runner/dist/commonjs/independent/suite-collector.js';
import { SuiteWorker } from '../packages/flashwright-runner/dist/commonjs/independent/suite-runtime.js';

const moduleFile = path.resolve('packages/flashwright-runner/dist/commonjs/independent/tracing.js');
const compiled = await readFile(moduleFile, 'utf8');
const originalRequire = createRequire(moduleFile);
const workbench = path.resolve('workbench');
await mkdir(workbench, { recursive: true });

async function fixture(body) {
  const root = await mkdtemp(path.join(workbench, 'independent-tracing-lifecycle-'));
  try { await body(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

/** Execute the compiled implementation with native boundaries replaced, retaining
 * the real finite-test ALS, fixture worker, policy validator and stack parser. */
function harness(settings = {}) {
  const state = { journals: [], observers: [], registrations: [], captures: [], archives: [], assemblies: [], activeObserver: undefined, browser: undefined, request: undefined, events: [] };
  function archive(kind) {
    const record = { kind, disposals: 0, exports: 0 };
    const value = {
      async dispose() { assert.equal(++record.disposals, 1, `${kind} archive disposed twice`); },
      async export(file) {
        record.exports++;
        if (settings.exportError) throw settings.exportError;
        await writeFile(file, 'mock archive bytes');
      },
    };
    record.value = value;
    state.archives.push(record);
    return value;
  }
  function lifecycle(kind, callbacks, existing) {
    const registration = { kind, callbacks, disposals: 0, pending: new Set() };
    state.registrations.push(registration);
    state[kind] = registration;
    const publish = context => {
      const claim = callbacks[kind === 'browser' ? 'beginContextCreation' : 'beginRequestCreation']();
      const operation = Promise.resolve().then(() => claim.didCreateContext(context)).finally(() => claim.complete());
      registration.pending.add(operation);
      void operation.then(() => registration.pending.delete(operation), () => registration.pending.delete(operation));
      return operation;
    };
    registration.publish = publish;
    const ready = Promise.all(existing.map(publish)).then(() => {});
    return {
      ready,
      async dispose() {
        assert.equal(++registration.disposals, 1);
        while (registration.pending.size) await Promise.allSettled([...registration.pending]);
        if (state[kind] === registration) state[kind] = undefined;
      },
    };
  }
  const integration = {
    beginTraceJournal(version, context, options) {
      assert.equal(version, 6);
      const record = { context, options, events: [], references: [], disposals: 0, takes: 0 };
      state.journals.push(record);
      state.events.push('journal');
      return {
        appendBeforeAction(event) { record.events.push({ type: 'before', ...event }); },
        appendAfterAction(stepId, error, attachments, annotations) { record.events.push({ type: 'after', stepId, error, attachments, annotations }); },
        appendError(error, parseStack) { record.events.push({ type: 'error', error, stack: parseStack(error.stack ?? '') }); },
        referenceSources(frames) { record.references.push(...frames); },
        async takeArchive() { assert.equal(++record.takes, 1); return archive('runner'); },
        async dispose() { assert.equal(++record.disposals, 1); },
      };
    },
    installActionObserver(version, observer) {
      assert.equal(version, 2);
      assert.equal(state.activeObserver, undefined);
      state.activeObserver = observer;
      state.observers.push(observer);
      state.events.push('observer');
      let restored = false;
      return () => { assert.equal(restored, false); restored = true; assert.equal(state.activeObserver, observer); state.activeObserver = undefined; };
    },
    installArtifactContextLifecycle(version, callbacks) { assert.equal(version, 9); return lifecycle('browser', callbacks, settings.existingBrowser ?? []); },
    installArtifactRequestLifecycle(version, callbacks) { assert.equal(version, 12); return lifecycle('request', callbacks, settings.existingRequest ?? []); },
    requestTraceOwner(version, context) { assert.equal(version, 12); return context.tracing; },
    async settleClosedTraceCleanup(version) { assert.equal(version, 11); },
    beginTraceRecordingWithActions(version, tracing, options, observer) {
      assert.equal(version, 11);
      const capture = { tracing, options, observer, takes: 0, stops: 0, cleanupReads: 0, discarded: 0 };
      state.captures.push(capture);
      const chunk = { async takeArchive() { assert.equal(++capture.takes, 1); return capture.archive = archive('library'); } };
      capture.chunk = chunk;
      return {
        ready: Promise.resolve({ chunk, async stop() { assert.equal(++capture.stops, 1); } }),
        get cleanup() { capture.cleanupReads++; return Promise.resolve(); },
      };
    },
    async discardTraceChunk(version, tracing, chunk) { assert.equal(version, 11); state.captures.find(capture => capture.chunk === chunk).discarded++; },
    createTraceArchiveAssembly(version) {
      assert.equal(version, 4);
      const record = { libraries: [], runners: [], sealed: false, disposals: 0 };
      state.assemblies.push(record);
      return {
        addLibrary(value) { record.libraries.push(value); },
        addRunner(value) { record.runners.push(value); },
        seal() {
          assert.equal(record.sealed, false);
          record.sealed = true;
          const combined = archive('combined');
          const dispose = combined.dispose;
          combined.dispose = async () => { await dispose(); for (const value of [...record.libraries, ...record.runners]) await value.dispose(); };
          return combined;
        },
        async dispose() {
          assert.equal(++record.disposals, 1);
          if (!record.sealed) for (const value of [...record.libraries, ...record.runners]) await value.dispose();
        },
      };
    },
  };
  const module = { exports: {} };
  const evaluate = runInThisContext(`(function(exports, require, module, __filename, __dirname) {\n${compiled}\n})`, { filename: moduleFile });
  evaluate(module.exports, name => name === '@flashwright/core/runner-integration' ? { runnerIntegration: integration } : originalRequire(name), module, moduleFile, path.dirname(moduleFile));
  return { api: module.exports, state };
}

async function run(root, mock, declare, mode = 'on') {
  const infos = [], results = [];
  const pool = new FixturePool({ trace: [mode, { option: true }], witness: [async ({}, use) => { mock.state.events.push('worker-fixture'); await use(); }, { scope: 'worker', auto: true }] });
  const collector = new SuiteCollector();
  await collector.collect(path.join(root, 'trace.spec.ts'), () => declare(collector.createTest(pool)));
  const tests = collector.seal();
  for (const planned of tests) mock.api.validateIndependentTrace(planned);
  const worker = new SuiteWorker(tests[0].pool);
  let result;
  try {
    result = await worker.run(tests, {
      async onBegin(planned, info) {
        const outputDir = path.join(root, `attempt-${infos.length}`);
        Object.assign(info, { outputDir, attachments: [], annotations: [], outputPath(name) { mkdirSync(outputDir, { recursive: true }); return path.join(outputDir, name); } });
        infos.push(info);
        await mock.api.beginIndependentTrace(planned, info);
      },
      async onResult(result) { results.push(result); await mock.api.finishIndependentTrace(result, infos[infos.length - 1]); },
    });
  } finally { assert.deepEqual(await worker.close(), []); }
  return { ...result, infos, observedResults: results };
}

const metadata = { apiName: 'page.title', className: 'Page', method: 'title', parameters: {}, stack: [] };

test('a trailing skipped attempt retains its afterAll trace owner', async () => fixture(async root => {
  const mock = harness();
  const result = await run(root, mock, test => {
    test('first', () => {});
    test.skip('trailing skipped', () => { throw Error('skipped body'); });
    test.afterAll(() => { mock.state.activeObserver.begin(metadata).complete(); });
  });
  assert.deepEqual(result.results.map(result => result.status), ['passed', 'skipped']);
  assert.equal(mock.state.journals.length, 2);
  assert.ok(mock.state.journals[1].events.some(event => event.title === 'page.title'));
}));

test('trace off allocates no journal, action observer, native recording or lifecycle registration', async () => fixture(async root => {
  const mock = harness();
  const result = await run(root, mock, test => test('off body', () => { assert.equal(mock.state.activeObserver, undefined); }), 'off');
  assert.equal(result.results[0].status, 'passed');
  for (const field of ['journals', 'observers', 'registrations', 'captures', 'archives', 'assemblies']) assert.deepEqual(mock.state[field], []);
  assert.deepEqual(mock.state.events, ['worker-fixture']);
}));

test('expired finite-info callbacks cannot claim successor browser or request creations', async () => fixture(async root => {
  const mock = harness();
  let release, late;
  const gate = new Promise(resolve => { release = resolve; });
  const result = await run(root, mock, test => {
    test('original', () => {
      late = gate.then(async () => {
        await mock.state.browser.publish({ tracing: { kind: 'stale browser' } });
        await mock.state.request.publish({ tracing: { kind: 'stale request' } });
      });
    });
    test('successor', async () => {
      release();
      await late;
      assert.equal(mock.state.captures.length, 0);
      await mock.state.browser.publish({ tracing: { kind: 'current browser' } });
      await mock.state.request.publish({ tracing: { kind: 'current request' } });
    });
  });
  assert.deepEqual(result.results.map(result => result.status), ['passed', 'passed']);
  assert.deepEqual(mock.state.captures.map(capture => capture.tracing.kind), ['current browser', 'current request']);
  assert.deepEqual(mock.state.events.slice(0, 3), ['journal', 'observer', 'worker-fixture']);
}));

test('stale observers and stale callbacks cannot append actions to the successor journal', async () => fixture(async root => {
  const mock = harness();
  let oldObserver, oldAction, release, late;
  const gate = new Promise(resolve => { release = resolve; });
  const result = await run(root, mock, test => {
    test('original', () => {
      oldObserver = mock.state.activeObserver;
      oldAction = oldObserver.begin(metadata);
      assert.ok(oldAction);
      late = gate.then(() => {
        assert.equal(oldObserver.begin(metadata), undefined);
        assert.equal(mock.state.activeObserver.begin(metadata), undefined);
        oldAction.complete(new Error('late completion'));
      });
    });
    test('successor', async () => {
      const originalEvents = mock.state.journals[0].events.length;
      const successorEvents = mock.state.journals[1].events.length;
      release(); await late;
      assert.equal(mock.state.journals[0].events.length, originalEvents);
      assert.equal(mock.state.journals[1].events.length, successorEvents);
      const action = mock.state.activeObserver.begin(metadata);
      assert.ok(action); action.complete();
    });
  });
  assert.deepEqual(result.results.map(result => result.status), ['passed', 'passed']);
  assert.equal(mock.state.journals[1].events.filter(event => event.type === 'before' && event.category === 'pw:api').length, 1);
}));

test('initial existing browser and request enrollment is admitted before active fixture scope', async () => fixture(async root => {
  const browser = { tracing: { kind: 'existing browser' } }, request = { tracing: { kind: 'existing request' } };
  const mock = harness({ existingBrowser: [browser], existingRequest: [request] });
  const result = await run(root, mock, test => test('uses enrolled owners', () => {
    assert.deepEqual(mock.state.captures.map(capture => capture.tracing), [browser.tracing, request.tracing]);
  }));
  assert.equal(result.results[0].status, 'passed');
  assert.deepEqual(mock.state.captures.map(capture => [capture.takes, capture.stops, capture.cleanupReads]), [[1, 1, 1], [1, 1, 1]]);
  assert.ok(result.infos[0].attachments.some(attachment => attachment.name === 'trace'));
}));

test('native archives transfer once and cleanup remains single-owned after early close sealing', async () => fixture(async root => {
  const mock = harness();
  const browser = { tracing: {} }, request = { tracing: {} };
  const result = await run(root, mock, test => test('early close', async () => {
    await mock.state.browser.publish(browser);
    await mock.state.request.publish(request);
    await mock.state.browser.callbacks.willCloseContext(browser);
    await mock.state.browser.callbacks.willCloseContext(browser);
    await mock.state.request.callbacks.willDisposeContext(request);
    await mock.state.request.callbacks.didCloseContext(request);
  }));
  assert.equal(result.results[0].status, 'passed');
  assert.deepEqual(mock.state.captures.map(capture => [capture.takes, capture.stops, capture.cleanupReads, capture.discarded]), [[1, 1, 1, 0], [1, 1, 1, 0]]);
  assert.equal(mock.state.assemblies[0].libraries.length, 2);
  assert.equal(mock.state.assemblies[0].runners.length, 1);
  assert.ok(mock.state.archives.every(archive => archive.disposals === 1));
  assert.ok(mock.state.registrations.every(registration => registration.disposals === 1));
}));

test('optional export failure retains original body error, failure source and cleanup custody', async () => fixture(async root => {
  const exportError = new Error('original export sentinel');
  const bodyError = new Error('original body sentinel');
  bodyError.stack = `Error: original body sentinel\n    at originalBody (${path.join(root, 'trace.spec.ts')}:17:9)`;
  const mock = harness({ exportError });
  const result = await run(root, mock, test => test('body and trace export fail', async () => {
    await mock.state.browser.publish({ tracing: {} });
    throw bodyError;
  }));
  assert.equal(result.results[0].status, 'failed');
  assert.equal(result.results[0].errors[0].error, bodyError);
  assert.equal(result.results[0].errors.length, 1);
  const info = result.infos[0];
  assert.equal(info.attachments.some(attachment => attachment.name === 'trace'), false);
  const diagnostic = info.attachments.find(attachment => attachment.name === 'trace-error');
  assert.ok(diagnostic);
  assert.match(await readFile(diagnostic.path, 'utf8'), /original export sentinel/);
  const event = mock.state.journals[0].events.find(event => event.type === 'error');
  assert.equal(event.error.message, bodyError.message);
  assert.equal(event.stack[0].file, path.join(root, 'trace.spec.ts'));
  assert.equal(event.stack[0].line, 17);
  assert.equal(event.stack[0].column, 9);
  assert.ok(mock.state.archives.every(archive => archive.disposals === 1));
  assert.deepEqual(mock.state.captures.map(capture => [capture.stops, capture.cleanupReads]), [[1, 1]]);
}));
