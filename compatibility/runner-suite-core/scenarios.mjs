// Both engines execute these same declarations and callbacks.
export function suiteScenarios(record) {
  const scenario = (name, declare) => ({ name, declare: test => declare(test, event => record(name, event)) });
  return [
    scenario('late-nested-declarations', (base, emit) => {
      const test = base.extend({
        option: ['default', { option: true }],
        value: async ({ option }, use) => { emit('setup:' + option); await use(option); emit('teardown:' + option); },
      });
      test('first', ({ value }) => emit('first:' + value));
      test.describe('nested', () => {
        test('nested-test', ({ value }) => emit('nested:' + value));
        test.beforeEach(({ value }) => emit('inner-before:' + value));
        test.afterEach(({ value }) => emit('inner-after-1:' + value));
        test.afterEach(({ value }) => emit('inner-after-2:' + value));
        test.use({ option: 'inner' });
      });
      test('last', ({ value }) => emit('last:' + value));
      test.use({ option: 'outer' });
      test.beforeAll(({ value }) => emit('beforeAll:' + value));
      test.beforeEach(({ value }) => emit('outer-before:' + value));
      test.afterEach(({ value }) => emit('outer-after:' + value));
      test.afterAll(({ value }) => emit('afterAll:' + value));
    }),
    scenario('test-type-hook-pools', (base, emit) => {
      const test = base.extend({ option: ['base', { option: true }] });
      const first = test.extend({ option: 'first' }), last = test.extend({ option: 'last' });
      test.beforeAll(({ option }) => emit('beforeAll:' + option));
      test.beforeEach(({ option }) => emit('beforeEach:' + option));
      first('first', ({ option }) => emit('body:' + option));
      last('last', ({ option }) => emit('body:' + option));
      test.afterAll(({ option }) => emit('afterAll:' + option));
    }),
    scenario('before-each-errors', (test, emit) => {
      test.beforeEach(() => { emit('outer-before-1'); throw new Error('before sentinel'); });
      test.beforeEach(() => emit('outer-before-2'));
      test.afterEach(() => emit('outer-after'));
      test.describe('nested', () => {
        test.beforeEach(() => emit('inner-before'));
        test.afterEach(() => { emit('inner-after-1'); throw new Error('after sentinel'); });
        test.afterEach(() => emit('inner-after-2'));
        test('failure', () => emit('must-not-run'));
      });
      test.afterAll(() => emit('outer-afterAll'));
    }),
    scenario('before-all-errors', (test, emit) => {
      test.beforeAll(() => { emit('outer-beforeAll-1'); throw new Error('beforeAll sentinel'); });
      test.beforeAll(() => emit('outer-beforeAll-2'));
      test.beforeEach(() => emit('must-not-run-beforeEach'));
      test.afterEach(() => emit('must-not-run-afterEach'));
      test.describe('nested', () => {
        test.beforeAll(() => emit('must-not-enter'));
        test.afterAll(() => emit('must-not-clean-unentered'));
        test('failure', () => emit('must-not-run'));
        test('blocked', () => emit('must-not-run-either'));
      });
      test.afterAll(() => emit('outer-afterAll'));
    }),
    scenario('body-and-cleanup-errors', (base, emit) => {
      const test = base.extend({ value: async ({}, use) => { emit('setup'); await use(1); emit('teardown'); throw new Error('fixture sentinel'); } });
      test.afterEach(() => { emit('afterEach-1'); throw new Error('afterEach sentinel'); });
      test.afterEach(() => emit('afterEach-2'));
      test.afterAll(() => { emit('afterAll-1'); throw new Error('afterAll sentinel'); });
      test.afterAll(() => emit('afterAll-2'));
      test('failure', ({ value }) => { emit('body'); throw new Error('body sentinel'); });
    }),
    scenario('expected-before-all-failure', (test, emit) => {
      test.beforeAll(() => { emit('beforeAll'); throw new Error('expected beforeAll sentinel'); });
      test.afterAll(() => emit('afterAll'));
      test.describe('nested', () => {
        test.beforeAll(() => emit('inner-beforeAll'));
        test.fail('expected', () => emit('must-not-run'));
        test('continue', () => emit('continue'));
        test.afterAll(() => emit('inner-afterAll'));
      });
    }),
    scenario('static-outcomes', (test, emit) => {
      test.beforeAll(() => emit('beforeAll'));
      test.skip('skip-first', () => emit('must-not-run'));
      test.describe.skip('disabled', () => { test('nested-skip', () => emit('must-not-run-either')); });
      test.fail('expected-failure', () => { emit('expected-failure'); throw new Error('expected sentinel'); });
      test('pass', () => emit('pass'));
      test.skip('skip-last', () => emit('must-not-run-last'));
      test.afterAll(() => emit('afterAll'));
    }),
    scenario('skipped-test-after-all-failure', (test, emit) => {
      test('pass', () => emit('pass'));
      test.skip('skip-last', () => emit('must-not-run'));
      test.afterAll(() => { emit('afterAll'); throw new Error('skipped cleanup sentinel'); });
    }),
    scenario('all-hooks-fixture-scopes', (base, emit) => {
      let count = 0;
      const test = base.extend({
        shared: [async ({}, use) => { emit('worker-setup'); await use(1); emit('worker-teardown'); }, { scope: 'worker' }],
        auto: [async ({ shared }, use) => { const id = ++count; emit('auto-setup:' + id); await use(id); emit('auto-teardown:' + id); }, { auto: 'all-hooks-included' }],
      });
      test.beforeAll(() => emit('beforeAll-1'));
      test.beforeAll(() => emit('beforeAll-2'));
      test('body', ({ auto }) => emit('body:' + auto));
      test.afterAll(() => emit('afterAll-1'));
      test.afterAll(() => emit('afterAll-2'));
    }),
  ];
}
