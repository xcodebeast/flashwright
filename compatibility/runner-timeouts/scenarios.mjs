import { setTimeout as delay } from 'node:timers/promises';

export function timeoutScenarios(record) {
  const scenario = (name, declare) => ({ name, declare: base => declare(base, event => record(name, event)) });
  return [
    scenario('shared-budget', (base, emit) => {
      const test = base.extend({ value: async ({}, use) => { emit('setup'); await delay(140); await use(1); emit('teardown'); } });
      test.beforeEach(async ({ value }) => { emit('before:' + value); await delay(140); });
      test.afterEach(() => emit('after'));
      test('shared', async ({ value }) => { emit('body:' + value); await delay(10000); });
    }),
    scenario('fresh-cleanup', (base, emit) => {
      const test = base.extend({ value: async ({}, use) => { await use(1); emit('teardown'); await delay(150); emit('teardown-done'); } });
      test.setTimeout(80);
      test.afterEach(async () => { emit('after'); await delay(150); emit('after-done'); });
      test('short test', async ({ value }) => { emit('body:' + value); await delay(10000); });
    }),
    scenario('exhausted-cleanup', (base, emit) => {
      const test = base.extend({
        separate: [async ({}, use) => { await use(1); emit('separate-teardown'); }, { timeout: 1000 }],
        outer: async ({ separate }, use) => { await use(separate); emit('outer-teardown'); },
        inner: async ({ outer }, use) => { await use(outer); emit('inner-teardown'); await delay(10000); },
      });
      test.afterAll(() => emit('afterAll'));
      test('cleanup', ({ inner }) => emit('body:' + inner));
    }),
    scenario('independent-all-hooks', (test, emit) => {
      test.setTimeout(80);
      test.beforeAll(async () => { emit('beforeAll-1'); await delay(250); });
      test.beforeAll(async () => { emit('beforeAll-2'); await delay(250); });
      test.afterAll(async () => { emit('afterAll'); await delay(100); });
      test('body', () => emit('body'));
    }),
    scenario('before-all-timeout', (test, emit) => {
      test.beforeAll(async () => { emit('beforeAll-1'); await delay(10000); });
      test.beforeAll(() => emit('beforeAll-2'));
      test.afterAll(() => emit('afterAll'));
      test('first', () => emit('first'));
      test('second', () => emit('second'));
    }),
    scenario('fixture-shared-slot', (base, emit) => {
      const test = base.extend({ value: [async ({}, use) => { emit('setup'); await delay(160); await use(1); emit('teardown'); await delay(160); emit('teardown-done'); }, { timeout: 250 }] });
      test('fixture budget', ({ value }) => emit('body:' + value));
    }),
    scenario('fixture-use-pauses-slot', (base, emit) => {
      const test = base.extend({ value: [async ({}, use) => { await delay(40); await use(1); await delay(40); emit('teardown-done'); }, { timeout: 150 }] });
      test('paused', async ({ value }) => { emit('body:' + value); await delay(250); });
    }),
    scenario('worker-own-budget', (base, emit) => {
      const test = base.extend({ value: [async ({}, use) => { emit('worker-setup'); await delay(160); await use(1); emit('worker-teardown'); await delay(160); emit('worker-done'); }, { scope: 'worker' }] });
      test.setTimeout(80); test('short body', ({ value }) => emit('body:' + value));
    }),
    scenario('shorten-expired', (test, emit) => {
      test('shorten', async ({}, info) => { emit('body'); await delay(100); info.setTimeout(50); });
      test.afterEach(() => emit('after'));
    }),
    scenario('extend-elapsed', (test, emit) => {
      test.setTimeout(160);
      test('extend', async ({}, info) => { await delay(60); info.setTimeout(400); await delay(180); emit('body-done'); });
    }),
    scenario('slow-once', (test, emit) => {
      test.setTimeout(100);
      test('slow', async ({}, info) => { test.slow(); test.slow(); emit('timeout:' + info.timeout); await delay(180); emit('body-done'); });
    }),
    scenario('slow-before-all', (test, emit) => {
      test.setTimeout(100);
      test.beforeAll(() => { test.slow(); emit('beforeAll'); });
      test('first', ({}, info) => emit('first:' + info.timeout));
      test('second', async ({}, info) => { emit('second:' + info.timeout); await delay(180); });
    }),
    scenario('expected-failure-timeout', (test, emit) => {
      test.setTimeout(80); test.fail('timeout is unexpected', async () => { emit('body'); await delay(10000); });
    }),
    scenario('failure-then-cleanup-timeout', (base, emit) => {
      const test = base.extend({ value: async ({}, use) => { await use(1); emit('teardown'); await delay(10000); } });
      test('first error wins', ({ value }) => { emit('body:' + value); throw new Error('body sentinel'); });
    }),
    scenario('timeout-then-cleanup-failure', (base, emit) => {
      const test = base.extend({ value: async ({}, use) => { await use(1); emit('teardown'); throw new Error('cleanup sentinel'); } });
      test.setTimeout(80); test('timeout wins', async ({ value }) => { emit('body:' + value); await delay(10000); });
    }),
    scenario('disabled-budget', (test, emit) => {
      test.setTimeout(0); test('unbounded', async () => { await delay(450); emit('body-done'); });
    }),
    scenario('long-budget', (test, emit) => {
      test.setTimeout(2 ** 31 - 1500); test('long', async () => { await delay(60); emit('body-done'); });
    }),
    scenario('ordinary-timeout-error', (test, emit) => {
      test('API error', () => { emit('body'); const error = new Error('API timeout sentinel'); error.name = 'TimeoutError'; throw error; });
    }),
  ];
}
