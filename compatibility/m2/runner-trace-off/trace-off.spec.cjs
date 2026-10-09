const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');
const upstream = require(process.env.FLASHWRIGHT_TRACE_OFF_ENGINE === 'playwright' ? 'playwright/test' : '@flashwright/test');
const base = process.env.FLASHWRIGHT_TRACE_OFF_ENGINE === 'playwright'
  ? upstream._baseTest.extend({ trace: ['off', { scope: 'worker', option: true }] })
  : upstream.test;
const upstreamPath = process.env.FLASHWRIGHT_TRACE_OFF_ENGINE === 'playwright'
  ? require.resolve('playwright/package.json')
  : createRequire(createRequire(require.resolve('@flashwright/test')).resolve('@flashwright/runner/package.json')).resolve('flashwright-upstream-runner/package.json');
const upstreamRequire = createRequire(upstreamPath);
const globals = upstreamRequire(join(dirname(upstreamPath), 'lib/globals.js'));
const record = (phase, information = globals.currentTestInfo()) => {
  if (!information && phase === 'user-worker-finish') {
    appendFileSync(process.env.FLASHWRIGHT_TRACE_OFF_EVENTS, JSON.stringify({ phase, outsideTest: true }) + '\n');
    return;
  }
  assert(information, phase);
  const tracing = information._tracing;
  assert.equal(tracing.traceOptions(), undefined);
  if (process.env.FLASHWRIGHT_TRACE_OFF_ENGINE === 'flashwright') {
    assert.equal(tracing._traceEvents.length, 0, phase);
    assert.notEqual(tracing.appendBeforeActionForStep, Object.getPrototypeOf(tracing).appendBeforeActionForStep);
  }
  appendFileSync(process.env.FLASHWRIGHT_TRACE_OFF_EVENTS, JSON.stringify({ phase, testId: information.testId, retry: information.retry, title: information.title, traceEvents: tracing._traceEvents.length }) + '\n');
};
const test = base.extend({
  userOption: [async ({}, use) => {
    record('user-worker-option');
    await use('custom');
  }, { scope: 'worker', option: true }],
  userWorker: [async ({ userOption }, use) => {
    record('user-auto-worker');
    assert.equal(userOption, 'custom');
    await test.step('user worker step', async () => {});
    await use();
    record('user-worker-finish');
  }, { scope: 'worker', auto: true }],
  userTest: [async ({}, use, testInfo) => {
    record('user-auto-test', testInfo);
    await test.step('user test fixture step', async () => {});
    await use();
    record('user-test-finish', testInfo);
  }, { auto: true }],
});
test.beforeAll(async () => record('beforeAll'));
test.beforeEach(async () => record('beforeEach'));
test.afterEach(async () => record('afterEach'));
test.afterAll(async () => record('afterAll'));
test('ordinary first', async () => {
  record('test-first');
  await test.step('first body', async () => {});
});
test('retry case', async ({}, testInfo) => {
  record('test-retry');
  if (testInfo.retry === 0) throw new Error('intentional first-attempt failure');
});
test('ordinary successor', async ({}, information) => {
  record('test-successor');
  for (let index = 0; index < 100; index++) await test.step(`reporter step ${index}`, async () => {});
  await information.attach('retained attachment', { body: Buffer.from('reporter attachment'), contentType: 'text/plain' });
  process.stdout.write('trace-off stdout marker\n');
  process.stderr.write('trace-off stderr marker\n');
  record('trace-off-still-empty');
});
test.skip('static skip', async () => {});
test('runtime skip', async () => {
  record('before-runtime-skip');
  test.skip(true, 'intentional runtime skip');
});
const failingTest = base.extend({
  failingWorker: [async ({}, use) => {
    record('early-worker-failure');
    throw new Error('intentional early fixture failure');
  }, { scope: 'worker', auto: true }],
});
failingTest.describe('early failure', () => {
  failingTest.fail();
  failingTest('expected fixture failure', async () => { throw new Error('body must not run'); });
});
