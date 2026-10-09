const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { _baseTest: base, expect } = require('playwright/test');
const globals = require(join(dirname(require.resolve('playwright/package.json')), 'lib/globals.js'));
const candidate = process.env.FLASHWRIGHT_ADOPTION_ENGINE === 'flashwright';
const { adoptRunnerTraceJournal } = candidate ? require(process.env.FLASHWRIGHT_ADOPTION_MODULE) : {};
const finalized = new WeakSet();

/** Test-only finalizer exercises the real pinned final stop boundary without claiming browser capture. */
function setup(fixture, testInfo = globals.currentTestInfo()) {
  assert(testInfo);
  if (!candidate) return;
  const admission = adoptRunnerTraceJournal(fixture, testInfo);
  assert.equal(admission?.failure, undefined);
  if (!admission?.journal || finalized.has(testInfo)) return;
  finalized.add(testInfo);
  testInfo._tracing.stopIfNeeded = async () => {
    let archive;
    try {
      if (testInfo._tracing._shouldAbandonTrace()) return;
      archive = await admission.journal.takeArchive(testInfo.timeout, new AbortController().signal);
      const path = testInfo.outputPath('trace.zip');
      await archive.export(path, new AbortController().signal);
      testInfo.attachments.push({ name: 'trace', path, contentType: 'application/zip' });
    } finally { await archive?.dispose(); await admission.journal.dispose(); }
  };
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
