const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const candidate = process.env.FLASHWRIGHT_ADOPTION_ENGINE === 'flashwright';
const runtime = candidate ? join(dirname(process.env.FLASHWRIGHT_ADOPTION_MODULE), '../upstream') : dirname(require.resolve('playwright/package.json'));
const { _baseTest: base, expect } = require(join(runtime, 'test.js'));
const globals = require(join(runtime, 'lib/globals.js'));
const { adoptRunnerTraceJournal } = candidate ? require(process.env.FLASHWRIGHT_ADOPTION_MODULE) : {};
const { installRunnerTraceFinalizer } = candidate ? require(join(dirname(process.env.FLASHWRIGHT_ADOPTION_MODULE), 'runner-trace-finalizer.js')) : {};

/** Exercise private production journal and final-stop owners through the actual pinned runner. */
function setup(fixture, testInfo = globals.currentTestInfo()) {
  assert(testInfo);
  if (!candidate) return;
  const admission = adoptRunnerTraceJournal(fixture, testInfo);
  assert.equal(admission?.failure, undefined);
  if (admission) installRunnerTraceFinalizer(testInfo, admission);
}

function phase(name, testInfo = globals.currentTestInfo()) {
  if (!testInfo) { appendFileSync(process.env.FLASHWRIGHT_ADOPTION_EVENTS, JSON.stringify({ phase: name, outsideTest: true }) + '\n'); return; }
  const records = testInfo._tracing._traceEvents.length;
  if (candidate) assert.equal(records, 0, name);
  appendFileSync(process.env.FLASHWRIGHT_ADOPTION_EVENTS, JSON.stringify({ phase: name, title: testInfo.title, retry: testInfo.retry, project: testInfo.project.name, records }) + '\n');
}

const test = base.extend({
  _setupWorkerTraceJournal: [async ({}, use) => { setup('_setupWorkerTraceJournal'); await use(); }, { scope: 'worker', auto: true }],
  _setupTestTraceJournal: [async ({}, use, testInfo) => { setup('_setupTestTraceJournal', testInfo); await use(); }, { auto: 'all-hooks-included' }],
  trace: ['off', { scope: 'worker', option: true }],
  userWorkerOption: [async ({}, use) => {
    phase('worker option');
    await use('value');
  }, { scope: 'worker', option: true }],
  userWorker: [async ({ userWorkerOption }, use) => {
    assert.equal(userWorkerOption, 'value'); phase('worker setup');
    await test.step('user worker step', async () => {});
    await use();
    phase('worker teardown');
    const information = globals.currentTestInfo();
    if (information) await information.attach('failed worker cleanup', { body: 'original worker cleanup', contentType: 'text/plain' });
  }, { scope: 'worker', auto: true }],
  userTest: [async ({}, use, testInfo) => {
    phase('test fixture setup', testInfo); await use(); phase('test fixture teardown', testInfo);
    await testInfo.attach('test fixture cleanup', { body: 'fixture tail', contentType: 'text/plain' });
  }, { auto: true }],
});
test.beforeAll(async ({}, testInfo) => { phase('beforeAll'); await testInfo.attach('beforeAll', { body: 'first hook', contentType: 'text/plain' }); });
test.afterAll(async ({}, testInfo) => { phase('afterAll'); await testInfo.attach('afterAll', { body: 'last hook', contentType: 'text/plain' }); });
test.beforeEach(async () => phase('beforeEach'));
test.afterEach(async ({}, testInfo) => { phase('afterEach'); await testInfo.attach('afterEach', { body: 'after hook', contentType: 'text/plain' }); });

module.exports = { test, phase, expect, globals };
