const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const modules = process.env.FLASHWRIGHT_SOURCE_MODULES;
const runtime = join(modules, '../upstream');
const { _baseTest: base, expect } = require(join(runtime, 'test.js'));
const { runnerIntegration } = require('@flashwright/core/runner-integration');
const { chromium } = require('flashwright');
const { adoptRunnerTraceAtStart } = require(join(modules, 'runner-trace-journal.js'));
const { installRunnerTraceFinalizer } = require(join(modules, 'runner-trace-finalizer.js'));
const { createOwnedTraceSteps } = require(join(modules, 'trace-steps.js'));
const { upstreamRequire } = require(join(modules, 'upstream-runtime.js'));
const { utils } = upstreamRequire('playwright-core/lib/coreBundle');
const { readPageTitle } = require('./source-helper.cjs');
const attempts = new WeakMap();
let retainedStepZone;
let retainedExpectZone;
const retainingExpect = expect.extend({ toRetainZone() {
  retainedExpectZone = utils.currentZone();
  return { pass: true, message: () => 'retained expectation zone' };
} });

require(join(runtime, 'flashwright-hooks.cjs')).installTraceStart(information => {
  const admission = adoptRunnerTraceAtStart(information);
  assert.equal(admission.failure, undefined); assert.ok(admission.journal);
  const steps = createOwnedTraceSteps(information, admission.journal);
  const owned = { steps, archives: [], reads: [], journal: admission.journal };
  attempts.set(information, owned);
  let closed = false;
  const finalizer = installRunnerTraceFinalizer(information, admission, {
    closeAdmission() { closed = true; steps.close(); },
    async collect(acceptArchive, signal) {
      assert.equal(closed, true);
      while (owned.archives.length) {
        signal.throwIfAborted();
        acceptArchive(owned.archives[0]);
        owned.archives.shift();
      }
    },
    async dispose() {
      const results = await Promise.allSettled(owned.archives.splice(0).map(archive => archive.dispose()));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
  });
  void finalizer.cleanup.then(() => {
    appendFileSync(process.env.FLASHWRIGHT_SOURCE_EVENTS, JSON.stringify({ title: information.title, project: information.project.name, reads: owned.reads }) + '\n');
  });
  return true;
});

const test = base.extend({
  trace: ['on', { scope: 'worker', option: true }],
  browser: [async ({}, use) => {
    const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: 'worker' }],
  capture: async ({ browser }, use, information) => {
    const owned = attempts.get(information);
    await owned.journal.initialization;
    const captureFile = owned.journal.resources.captureFile.bind(owned.journal.resources);
    owned.journal.resources.captureFile = (...arguments_) => { owned.reads.push(arguments_[0]); return captureFile(...arguments_); };
    const context = await browser.newContext();
    const recording = await runnerIntegration.startTraceRecordingWithActions(10, context.tracing, { sources: false, snapshots: false, screenshots: false }, owned.steps.observer);
    const page = await context.newPage();
    const retain = async () => {
      const archive = await runnerIntegration.currentTraceChunk(3, context.tracing).takeArchive();
      const reader = archive.acquire();
      try { assert(!reader.entries.some(entry => entry.name.startsWith('resources/')), 'library capture must not ingest sources'); }
      finally { reader.release(); }
      owned.archives.push(archive);
    };
    try { await use({ page, context, recording, retain, observer: owned.steps.observer }); }
    finally { await retain(); await recording.stop(); await context.close(); }
  },
});

test('original sources and retained parent zones', async ({ capture }) => {
  assert.equal(await readPageTitle(capture.page), '');
  await test.step('original user parent', async () => { retainedStepZone = utils.currentZone(); });
  retainingExpect(1).toRetainZone();
});
test('reused recording owns both chunks', async ({ capture }) => {
  assert.equal(await readPageTitle(capture.page), '');
  await capture.retain();
  await capture.recording.startChunk(capture.observer, { title: 'second original chunk' });
  assert.equal(await readPageTitle(capture.page), '');
});
test('successor actions exclude old step and expect parents', async ({ capture }, information) => {
  assert.ok(retainedStepZone); assert.ok(retainedExpectZone);
  assert.equal(await retainedStepZone.run(() => readPageTitle(capture.page)), '');
  await capture.page.evaluate(() => { document.body.innerHTML = '<div>visible</div>'; });
  const result = await retainedExpectZone.run(() => capture.page.locator('body').runAssertion({ expression: 'to.be.visible', isNot: false }, 1000));
  assert.equal(result.matches, true);
  for (const zone of [retainedStepZone, retainedExpectZone]) {
    const parent = zone.data('stepZone');
    assert.notEqual(information._stepMap.get(parent.stepId), parent);
  }
});
