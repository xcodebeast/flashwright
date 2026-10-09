import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';

const require = createRequire(resolve('packages/flashwright-runner/package.json'));
const upstreamRequire = createRequire(require.resolve('flashwright-upstream-runner/package.json'));
const globals = upstreamRequire(join(dirname(upstreamRequire.resolve('flashwright-upstream-runner/package.json')), 'lib/globals.js'));
const { utils, iso } = upstreamRequire('playwright-core/lib/coreBundle');
const { installTraceSteps } = require(resolve('packages/flashwright-runner/dist/commonjs/trace-steps.js'));
const { runnerIntegration } = require('@flashwright/core/runner-integration');
const { Tracing } = require(resolve('packages/flashwright-core/dist/commonjs/tracing.js'));
const { instrumentTraceMethods, runTraceInternal, runTraceUserCallback } = require(resolve('packages/flashwright-core/dist/commonjs/trace-hooks.js'));
const directory = await mkdtemp(join(tmpdir(), 'flashwright-runner-step-tests-'));
const report = { status: 'running', checks: [] };
let nextTrace = 0;

// Evaluate the actual pinned event serializer without starting its worker process.
const worker = await readFile(upstreamRequire.resolve('./lib/worker/workerProcessEntry.js'), 'utf8');
const start = worker.indexOf('var TestTracing = class {');
const end = worker.indexOf('async function mergeTraceFiles(', start);
assert(start > 0 && end > start);
const PinnedTracing = vm.runInNewContext(`${worker.slice(start, end)}\nTestTracing;`, {
  process: { platform: process.platform }, Date, Buffer,
  import_path2: { default: path }, import_coreBundle: { getPlaywrightVersion: () => '1.60.0' },
  monotonicTime2: () => performance.now() + 1000, version: 8, traceOrdinal: 0,
}, { timeout: 1000 });

function information() {
  const calls = [];
  const testInfo = {
    retry: 0, status: 'passed', expectedStatus: 'passed', calls,
    _addStep(data) {
      const step = { ...data, stepId: `step-${calls.length + 1}`, completions: [] };
      calls.push(step);
      const parent = utils.currentZone().data('stepZone');
      this._tracing.appendBeforeActionForStep({ ...data, stepId: step.stepId, parentId: parent?.stepId, stack: data.location ? [data.location] : [] });
      step.complete = result => {
        step.completions.push(result);
        this._tracing.appendAfterActionForStep(step.stepId, result.error ? { message: result.error.message } : undefined);
      };
      return step;
    },
  };
  testInfo._tracing = new PinnedTracing(testInfo, directory);
  return testInfo;
}

class Driver {
  generation;
  async request(method, parameters) {
    if (method === 'context.trace.start') { this.generation = parameters.generation; return null; }
    assert.equal(parameters.generation, this.generation);
    if (method === 'context.trace.stop') this.generation = undefined;
    return { generation: parameters.generation, events: [] };
  }
}

class Operations {
  constructor(tracing) { this.tracing = tracing; }
  async value(value) { return value; }
  async nested(value) { return this.value(value); }
  async callback(callback) { return runTraceUserCallback(callback); }
  async wait(promise) { return promise; }
  async reject(error) { throw error; }
  throwNow(error) { throw error; }
  async assertion(_options, result = { matches: true }) { return result; }
}
instrumentTraceMethods(Operations.prototype, 'Frame', owner => ({ tracing: owner.tracing, pageId: 'page', selector: '#subject' }), {
  value: { method: 'evaluateExpression', parameters: ['expression'] }, nested: { method: 'click' },
  callback: { method: 'evaluateExpression' }, wait: { method: 'waitForSelector' },
  reject: { method: 'click' }, throwNow: { method: 'click' }, assertion: { method: 'expect', apiName: 'locator._expect', parameters: ['options'] },
}, 'Locator');

async function withTrace(callback) {
  const tracing = new Tracing(new Driver(), `context-${++nextTrace}`, null);
  const operations = new Operations(tracing);
  try { await callback(tracing, operations); }
  finally { await tracing.stop().catch(() => {}); tracing.ownerClosed(); }
}

async function records(file) {
  const archive = new utils.ZipFile(file);
  try { return (await archive.read('trace.trace')).toString().trim().split('\n').map(JSON.parse); }
  finally { archive.close(); }
}

async function check(name, callback) { await callback(); report.checks.push(name); }

try {
  await check('private observer validation and inactive tracing preserve ordinary results', async () => {
    assert.throws(() => runnerIntegration.installActionObserver(1, {}), { name: 'ProtocolError' });
    assert.throws(() => runnerIntegration.installActionObserver(2, {}), { name: 'ProtocolError' });
    let calls = 0;
    const uninstall = runnerIntegration.installActionObserver(2, { begin() { calls++; } });
    try {
      assert.throws(() => runnerIntegration.installActionObserver(2, { begin() {} }), /already active/);
      await withTrace(async (_tracing, operations) => assert.equal(await operations.value(42), 42));
      assert.equal(calls, 0);
    } finally { uninstall(); uninstall(); }
  });

  await check('ordinary steps preserve caller locations, original values, failures and bounded safe previews', async () => {
    const testInfo = information(); globals.setCurrentTestInfo(testInfo);
    const uninstall = installTraceSteps(testInfo);
    try {
      await withTrace(async (tracing, operations) => {
        await tracing.start();
        let accessors = 0;
        const value = { get danger() { accessors++; throw new Error('accessor invoked'); } };
        assert.equal(await operations.value(value), value);
        const original = new Error('original rejected value');
        await assert.rejects(operations.reject(original), error => error === original);
        assert.throws(() => operations.throwNow(original), error => error === original);
        await Promise.resolve();
        const file = join(directory, 'ordinary.zip');
        await tracing.stop({ path: file });
        assert.equal(accessors, 0);
        assert.equal(testInfo.calls.length, 3);
        assert(testInfo.calls[0].location.file.endsWith('test-runner-trace-steps.mjs'));
        assert.equal(testInfo.calls[0].params.expression.danger, '[Accessor]');
        assert.equal(testInfo.calls[0].completions.length, 1);
        assert.equal(testInfo.calls[1].completions[0].error, original);
        assert.equal(testInfo.calls[2].completions[0].error, original);
        const before = (await records(file)).filter(event => event.type === 'before');
        assert.deepEqual(before.map(event => event.stepId), testInfo.calls.map(step => step.stepId));
        assert.deepEqual(before.map(event => event.title), testInfo.calls.map(step => step.title));
      });
    } finally { uninstall(); globals.setCurrentTestInfo(undefined); }
  });

  await check('nested implementation and internal captures share calls while user callbacks create their own', async () => {
    const testInfo = information(); globals.setCurrentTestInfo(testInfo);
    const uninstall = installTraceSteps(testInfo);
    try {
      await withTrace(async (tracing, operations) => {
        await tracing.start();
        assert.equal(await operations.nested(7), 7);
        assert.equal(await runTraceInternal(() => operations.value(8)), 8);
        assert.equal(await operations.callback(() => operations.value(9)), 9);
        assert.deepEqual(testInfo.calls.map(call => call.apiName), ['locator.nested', 'locator.callback', 'locator.value']);
        assert(testInfo.calls.every(call => call.completions.length === 1));
      });
    } finally { uninstall(); globals.setCurrentTestInfo(undefined); }
  });

  await check('expect actions reuse the original step and actual pinned viewer merges clocks and parents', async () => {
    const testInfo = information(); globals.setCurrentTestInfo(testInfo);
    const uninstall = installTraceSteps(testInfo);
    try {
      await withTrace(async (tracing, operations) => {
        await tracing.start();
        const outer = { category: 'test.step', stepId: 'outer', title: 'user step' };
        testInfo._tracing.appendBeforeActionForStep({ ...outer, stack: [] });
        await utils.currentZone().with('stepZone', outer).run(() => operations.nested(11));
        let prematureCompletion = 0;
        const expectation = { category: 'expect', stepId: 'expectation', title: 'long matcher title', shortTitle: 'expect.toHaveText', complete() { prematureCompletion++; } };
        testInfo._tracing.appendBeforeActionForStep({ ...expectation, parentId: outer.stepId, stack: [] });
        await utils.currentZone().with('stepZone', expectation).run(() => operations.assertion());
        assert.equal(prematureCompletion, 0);
        assert.equal(testInfo.calls.length, 1);
        testInfo._tracing.appendAfterActionForStep(expectation.stepId, { message: 'matcher owns this failure' });
        testInfo._tracing.appendAfterActionForStep(outer.stepId);
        const file = join(directory, 'merged.zip');
        await tracing.stop({ path: file });
        const library = await records(file);
        const files = new Map([
          ['0-trace.trace', library.map(event => JSON.stringify(event)).join('\n')],
          ['test.trace', testInfo._tracing._traceEvents.map(event => JSON.stringify(event)).join('\n')],
        ]);
        const loader = new iso.TraceLoader();
        await loader.load({ entryNames: async () => [...files.keys()], readText: async name => files.get(name), hasEntry: async name => files.has(name), isLive: () => false });
        const model = new iso.TraceModel('controlled-step-merge', loader.contextEntries);
        assert.equal(model.actions.length, 3);
        const nested = model.actions.find(action => action.stepId === testInfo.calls[0].stepId);
        const expected = model.actions.find(action => action.stepId === expectation.stepId);
        assert.equal(nested.parentId, outer.stepId);
        assert.equal(expected.parentId, outer.stepId);
        assert.equal(expected.error.message, 'matcher owns this failure');
        assert.equal(expected.title, 'expect.toHaveText');
        const libraryAction = library.find(event => event.type === 'before');
        assert(Math.abs(nested.startTime - libraryAction.startTime - 1000) < 50);
      });
    } finally { uninstall(); globals.setCurrentTestInfo(undefined); }
  });

  await check('manual assertion traces retain top-level predicate options and unsuccessful negation outcomes', async () => {
    await withTrace(async (tracing, operations) => {
      await tracing.start();
      const cases = [];
      for (const expected of ['ready', 'a'.repeat(5000)]) for (const isNot of [false, true]) for (const matches of [false, true]) {
        const options = { expression: 'to.have.text', expectedText: [{ string: expected, normalizeWhiteSpace: true }], expectedValue: { checked: true }, isNot };
        const result = { received: expected, matches, timedOut: matches === isNot };
        assert.equal(await operations.assertion(options, result), result);
        cases.push({ options, result });
      }
      const file = join(directory, 'manual-expect.zip');
      await tracing.stop({ path: file });
      const events = await records(file);
      const before = events.filter(event => event.type === 'before');
      const after = events.filter(event => event.type === 'after');
      assert.equal(before.length, cases.length);
      for (let index = 0; index < cases.length; index++) {
        const { options, result } = cases[index];
        assert.equal(before[index].params.options, undefined);
        assert.equal(before[index].params.expression, options.expression);
        assert.equal(before[index].params.isNot, options.isNot);
        if (options.expectedText[0].string === 'ready') assert.deepEqual(before[index].params.expectedText, options.expectedText);
        assert(before[index].params.expectedValue.value);
        assert.deepEqual(after[index].error, result.matches === options.isNot ? { name: 'Expect', message: 'Expect failed' } : undefined);
      }
    });
  });

  await check('unfinished calls retain their original step after observer and chunk replacement', async () => {
    const first = information(); globals.setCurrentTestInfo(first);
    let uninstall = installTraceSteps(first);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    try {
      await withTrace(async (tracing, operations) => {
        await tracing.start();
        const old = operations.wait(gate);
        const file = join(directory, 'unfinished.zip');
        await tracing.stopChunk({ path: file });
        uninstall();
        const second = information(); globals.setCurrentTestInfo(second);
        uninstall = installTraceSteps(second);
        await tracing.startChunk();
        await operations.value(2);
        release(1);
        assert.equal(await old, 1);
        assert.equal(first.calls[0].completions.length, 1);
        assert.equal(second.calls.length, 1);
        assert.equal(second.calls[0].completions.length, 1);
        assert.equal((await records(file)).filter(event => event.type === 'after').length, 0);
      });
    } finally { release(); uninstall(); globals.setCurrentTestInfo(undefined); }
  });

  await check('observer faults preserve public outcomes and reject export without replacing a prior file', async () => {
    for (const mode of ['begin', 'complete', 'identity']) {
      const original = new Error(`observer ${mode} failure`);
      const uninstall = runnerIntegration.installActionObserver(2, {
        begin() {
          if (mode === 'begin') throw original;
          return { stepId: mode === 'identity' ? '' : 'step', complete() { if (mode === 'complete') throw original; } };
        },
      });
      try {
        await withTrace(async (tracing, operations) => {
          const file = join(directory, `fault-${mode}.zip`);
          await writeFile(file, 'previous destination');
          await tracing.start();
          assert.equal(await operations.value(17), 17);
          await assert.rejects(tracing.stop({ path: file }), error => mode === 'identity' ? error.name === 'ProtocolError' : error === original);
          assert.equal(await readFile(file, 'utf8'), 'previous destination');
        });
      } finally { uninstall(); }
    }
  });

  await check('a different active test cannot acquire actions through an old scope observer', async () => {
    const first = information(); const second = information();
    const uninstall = installTraceSteps(first); globals.setCurrentTestInfo(second);
    try {
      await withTrace(async (tracing, operations) => { await tracing.start(); await operations.value(5); });
      assert.equal(first.calls.length, 0); assert.equal(second.calls.length, 0);
    } finally { uninstall(); globals.setCurrentTestInfo(undefined); }
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1;
} finally {
  globals.setCurrentTestInfo(undefined);
  await rm(directory, { recursive: true, force: true });
  if (process.env.FLASHWRIGHT_REPORT_PATH) await writeFile(process.env.FLASHWRIGHT_REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
