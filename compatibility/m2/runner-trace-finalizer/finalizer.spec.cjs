const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { _baseTest: base } = require('flashwright-upstream-runner/test');
const globals = require(join(dirname(require.resolve('flashwright-upstream-runner/package.json')), 'lib/globals.js'));
const { adoptRunnerTraceJournal } = require(join(process.env.FLASHWRIGHT_FINALIZER_MODULES, 'runner-trace-journal.js'));
const { installRunnerTraceFinalizer } = require(join(process.env.FLASHWRIGHT_FINALIZER_MODULES, 'runner-trace-finalizer.js'));
const { ScreenshotLifecycle } = require(join(process.env.FLASHWRIGHT_FINALIZER_MODULES, 'screenshot-recorder.js'));
const journals = new WeakMap();

function setup(fixture, information = globals.currentTestInfo()) {
  const admission = adoptRunnerTraceJournal(fixture, information);
  assert.equal(admission?.failure, undefined); assert.ok(admission?.journal);
  journals.set(information, admission.journal);
  installRunnerTraceFinalizer(information, admission);
}
const test = base.extend({
  _setupWorkerTraceJournal: [async ({}, use) => { setup('_setupWorkerTraceJournal'); await use(); }, { scope: 'worker', auto: true }],
  _setupTestTraceJournal: [async ({}, use, information) => { setup('_setupTestTraceJournal', information); await use(); }, { auto: 'all-hooks-included' }],
  trace: ['on', { scope: 'worker', option: true }],
});

function exceedJournalLimit(information) {
  journals.get(information).append({ type: 'stdout', timestamp: performance.now(), text: 'x'.repeat(256 * 1024) });
}
test('passing outcome survives capture failure', async ({}, information) => {
  information.setTimeout(4567); exceedJournalLimit(information);
});
test('expected failure keeps its original error', async ({}, information) => {
  information.setTimeout(5678); test.fail(); exceedJournalLimit(information); throw Error('original expected test failure');
});
test('healthy successor owns a complete trace', async ({}, information) => {
  information.setTimeout(6001); await information.attach('original successor body', { body: 'successor bytes', contentType: 'text/plain' });
});
test('cleanup failure keeps the committed trace and passing outcome', async ({}, information) => {
  information.setTimeout(6789);
  const journal = journals.get(information); const originalDispose = journal.dispose.bind(journal);
  journal.dispose = async () => { await originalDispose(); throw Error('cleanup failed after original journal settlement'); };
});
test('final preparation outlives only the separate export slot', async ({}, information) => {
  information.setTimeout(7890);
  const journal = journals.get(information); const originalTake = journal.takeArchive.bind(journal);
  journal.takeArchive = async (...arguments_) => {
    const started = performance.now(); await new Promise(resolve => setTimeout(resolve, 2500));
    appendFileSync(process.env.FLASHWRIGHT_FINALIZER_EVENTS, JSON.stringify({ elapsed: performance.now() - started, timeout: information.timeout, status: information.status }) + '\n');
    return originalTake(...arguments_);
  };
});
test('screenshot diagnostics publish every collected message to the reporter', async ({}, information) => {
  information.setTimeout(8001);
  const lifecycle = new ScreenshotLifecycle({ mode: 'on', options: {} });
  const pages = [1, 2, 3].map(index => ({ screenshot: async () => {
    const error = Error(`original screenshot failure ${index}`);
    if (index === 3) Object.defineProperty(error, 'stack', { get() { throw Error('diagnostic formatting must not escape'); } });
    throw error;
  } }));
  lifecycle.contexts.add({ pages: () => pages });
  try { await lifecycle.finish(lifecycle.start(information)); }
  finally { lifecycle.dispose(); }
});
