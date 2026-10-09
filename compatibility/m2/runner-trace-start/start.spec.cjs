const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const runtime = process.env.FLASHWRIGHT_START_RUNTIME;
const { _baseTest: base, expect } = require(join(runtime, 'test.js'));
const globals = require(join(runtime, 'lib/globals.js'));
const candidate = process.env.FLASHWRIGHT_START_ENGINE === 'flashwright';
const record = (phase, information = globals.currentTestInfo()) => {
  if (!information) return;
  if (candidate) {
    assert.equal(information._tracing._traceEvents.length, 0);
    assert.equal(information._tracing._liveTraceFile, undefined);
  }
  appendFileSync(process.env.FLASHWRIGHT_START_EVENTS, JSON.stringify({ phase, title: information.title, retry: information.retry, project: information.project.name }) + '\n');
};
if (candidate) {
  const { adoptRunnerTraceAtStart } = require(join(process.env.FLASHWRIGHT_START_MODULES, 'runner-trace-journal.js'));
  const { installRunnerTraceFinalizer } = require(join(process.env.FLASHWRIGHT_START_MODULES, 'runner-trace-finalizer.js'));
  require(join(runtime, 'flashwright-hooks.cjs')).installTraceStart(information => {
    assert.equal(information, globals.currentTestInfo());
    assert.equal(information._tracing._traceEvents.length, 1);
    assert.equal(information._tracing._liveTraceFile, undefined);
    const admission = adoptRunnerTraceAtStart(information);
    if (admission) installRunnerTraceFinalizer(information, admission);
    record('owned start', information);
    return true;
  });
}
const test = base.extend({
  trace: ['off', { scope: 'worker', option: true }],
  marker: [async ({}, use) => { record('worker option'); await use('original'); }, { scope: 'worker', option: true }],
  userWorker: [async ({ marker }, use) => {
    assert.equal(marker, 'original'); record('worker setup'); await use(); record('worker cleanup');
  }, { scope: 'worker', auto: true }],
  userTest: [async ({}, use, information) => {
    record('test fixture', information); await use(); record('test cleanup', information);
  }, { auto: true }],
});
test('passing body', async ({}, information) => {
  record('body');
  await test.step('original nested step', async () => {});
  const body = Buffer.from('original attachment');
  await information.attach('body', { body, contentType: 'text/plain' });
  body.fill(120);
  expect(true).toBe(true);
});
test('expected failure', async () => { test.fail(); throw Error('original expected failure'); });
test('retry identity', async ({}, information) => { if (!information.retry) throw Error('original retry failure'); });
test.describe('callback modifier', () => {
  test.skip(({ marker }) => { assert.equal(marker, 'original'); record('modifier'); return true; });
  test('callback skipped body', async () => { throw Error('skipped body must not execute'); });
});
test.skip('last skipped without fixtures', async () => { throw Error('skipped body must not execute'); });
