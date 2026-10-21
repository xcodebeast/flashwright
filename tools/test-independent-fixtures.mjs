import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixturePool, FixtureConfigurationError, fixtureDependencies } from '../packages/flashwright-runner/dist/commonjs/independent/fixture-pool.js';
import { FixtureWorker } from '../packages/flashwright-runner/dist/commonjs/independent/fixture-runtime.js';

const rejects = definition => assert.throws(() => new FixturePool(definition).validate(), FixtureConfigurationError);

test('invalid dependency graphs reject before any fixture invocation', () => {
  rejects({ a: async ({ missing }, use) => use() });
  rejects({ a: async ({ a }, use) => use() });
  rejects({ a: async ({ b }, use) => use(), b: async ({ a }, use) => use() });
  rejects({ a: [async ({ b }, use) => use(), { scope: 'worker' }], b: 1 });
  rejects({ a: [1, { scope: 'invalid' }] });
  rejects({ a: [1, { timeout: 100 }] });
  rejects({ a: [1, { box: true }] });
  rejects({ a: [1, { title: 'custom' }] });
  rejects({ a: [1, { auto: 'invalid' }] });
  rejects({ a: [1, null] });
});

test('overrides preserve scope and auto, and describe rejects worker changes', () => {
  const pool = new FixturePool({ a: [1, { scope: 'worker', auto: true }], option: [2, { option: true }] });
  assert.throws(() => pool.extend({ a: [2, { scope: 'test', auto: true }] }), /scope or auto/);
  assert.throws(() => pool.extend({ a: [2, { scope: 'worker', auto: false }] }), /scope or auto/);
  assert.throws(() => pool.withUse({ a: 2 }, { inDescribe: true }), /inside describe/);
  assert.equal(pool.extend({ a: 2 }).resolve('a').auto, true);
  assert.throws(() => new FixturePool({ a: 1 }, { configurationUse: { a: 2 } }).validate(), /non-option/);
  assert.equal(pool.withUse({ option: 3 }).withUse({ option: undefined }).resolve('option').value, 2);
});

test('signature analysis handles common declarations and rejects ambiguous bindings', () => {
  assert.deepEqual(fixtureDependencies(async ({ a: renamed, b: { nested }, c: [first], }) => {}), ['a', 'b', 'c']);
  assert.deepEqual(fixtureDependencies(async (/* comment */ { a /* gap */, b }, use) => {}), ['a', 'b']);
  assert.deepEqual(fixtureDependencies(function named() {}), []);
  assert.deepEqual(fixtureDependencies({ async method({ a }) {} }.method), ['a']);
  for (const fn of [x => x, (x) => x, ({ ...rest }) => rest, ({ a = 1 }) => a, ({ ['x']: x }) => x]) assert.throws(() => fixtureDependencies(fn), FixtureConfigurationError);
});

test('worker values survive test scopes; test-only pool changes are permitted', async () => {
  let workers = 0, tests = 0;
  const pool = new FixturePool({ w: [async ({}, use) => { await use(++workers); }, { scope: 'worker' }], t: async ({}, use) => { await use(++tests); } });
  const worker = new FixtureWorker(pool, {});
  const first = worker.beginAttempt({});
  assert.deepEqual(await first.run(({ w, t }) => [w, t]), { ran: true, value: [1, 1] });
  assert.throws(() => worker.beginAttempt({}), /has not closed/);
  await first.close();
  const second = worker.beginAttempt({}, pool.extend({ extra: 3 }));
  assert.deepEqual(await second.run(({ w, t, extra }) => [w, t, extra]), { ran: true, value: [1, 2, 3] });
  await second.close();
  assert.throws(() => worker.beginAttempt({}, pool.extend({ w: 4 })), /fresh worker/);
  await worker.close();
  assert.throws(() => worker.beginAttempt({}), /closing/);
});

test('close retains pending callback ownership and rejects new work', async () => {
  let finish; const pending = new Promise(resolve => finish = resolve), events = [];
  const worker = new FixtureWorker(new FixturePool({ value: async ({}, use) => { events.push('setup'); await use(); events.push('teardown'); } }), {});
  const scope = worker.beginAttempt({});
  const run = scope.run(async ({ value }) => { events.push('body'); await pending; events.push('body-end'); });
  while (!events.includes('body')) await Promise.resolve();
  const close = worker.close(); let closed = false; void close.then(() => closed = true);
  await assert.rejects(scope.run(({}) => {}), /closing/);
  assert.equal(closed, false); assert.deepEqual(events, ['setup', 'body']);
  finish(); await run; await close; assert.deepEqual(events, ['setup', 'body', 'body-end', 'teardown']);
});

test('cleanup retains every rejection including falsy thrown values', async () => {
  const worker = new FixtureWorker(new FixturePool({ a: async ({}, use) => { await use(); throw undefined; }, b: async ({ a }, use) => { await use(); throw null; } }), {});
  const scope = worker.beginAttempt({});
  await assert.rejects(scope.run(({ b }) => { throw new Error('body'); }), /body/);
  await assert.rejects(scope.close(), error => { assert.deepEqual(error.errors, [null, undefined]); return true; });
  await worker.close();
});

test('failed automatic fixture does not prevent an unrelated after hook', async () => {
  const events = [], worker = new FixtureWorker(new FixturePool({ fail: [async ({}, use) => { throw new Error('setup'); }, { auto: true }] }), {});
  const scope = worker.beginAttempt({});
  await assert.rejects(scope.run(({}) => events.push('body')), /setup/);
  await scope.run(({}) => events.push('after'));
  await worker.close(); assert.deepEqual(events, ['after']);
});

test('late fixture errors are observed and belong to cleanup', async () => {
  const worker = new FixtureWorker(new FixturePool({ value: async ({}, use) => { void use(1); throw new Error('late sentinel'); } }), {});
  const scope = worker.beginAttempt({});
  assert.deepEqual(await scope.run(({ value }) => value), { ran: false });
  await assert.rejects(scope.close(), error => error.errors[0].message === 'late sentinel');
  await worker.close();
});

test('extension validation waits for the complete fixture graph', async () => {
  const base = new FixturePool({ item: async ({ later }, use) => use(later) });
  assert.throws(() => new FixtureWorker(base, {}), /unknown dependency/);
  const worker = new FixtureWorker(base.extend({ later: 17 }), {});
  assert.deepEqual(await worker.beginAttempt({}).run(({ item }) => item), { ran: true, value: 17 });
  await worker.close();
  const replaced = base.extend({ item: 8 });
  const replacementWorker = new FixtureWorker(replaced, {});
  assert.deepEqual(await replacementWorker.beginAttempt({}).run(({ item }) => item), { ran: true, value: 8 });
  await replacementWorker.close();
});

test('separately constructed equivalent pools reuse the same worker instance', async () => {
  let setups = 0;
  const fn = async ({}, use) => { await use(++setups); };
  const makePool = () => new FixturePool({ item: [fn, { scope: 'worker' }] });
  const worker = new FixtureWorker(makePool(), {});
  const first = worker.beginAttempt({});
  assert.deepEqual(await first.run(({ item }) => item), { ran: true, value: 1 }); await first.close();
  const second = worker.beginAttempt({}, makePool());
  assert.deepEqual(await second.run(({ item }) => item), { ran: true, value: 1 }); await worker.close();
  assert.equal(setups, 1);
});

test('close also owns a pending fixture setup through its eventual teardown', async () => {
  let release; const pending = new Promise(resolve => release = resolve), events = [];
  const worker = new FixtureWorker(new FixturePool({ item: async ({}, use) => { events.push('setup'); await pending; await use(7); events.push('teardown'); } }), {});
  const scope = worker.beginAttempt({});
  const run = scope.run(({ item }) => events.push('body:' + item));
  while (!events.length) await Promise.resolve();
  const close = worker.close(); assert.equal(worker.close(), close);
  await assert.rejects(scope.run(({}) => {}), /closing/);
  assert.deepEqual(events, ['setup']); release(); await run; await close;
  assert.deepEqual(events, ['setup', 'body:7', 'teardown']);
});

test('a failed required fixture blocks dependents but allows unrelated cleanup', async () => {
  let invoked = false;
  const worker = new FixtureWorker(new FixturePool({ fail: async ({}, use) => { throw new Error('setup'); }, dependent: async ({ fail }, use) => { invoked = true; await use(); } }), {});
  const scope = worker.beginAttempt({});
  await assert.rejects(scope.run(({ fail }) => {}), /setup/);
  assert.deepEqual(await scope.run(({ dependent }) => { throw new Error('must not run'); }), { ran: false });
  assert.equal(invoked, false); assert.deepEqual(await scope.run(({}) => 1), { ran: true, value: 1 });
  await worker.close();
});

test('worker close retains both test and worker teardown failures', async () => {
  const worker = new FixtureWorker(new FixturePool({ worker: [async ({}, use) => { await use(); throw new Error('worker'); }, { scope: 'worker' }], test: async ({ worker }, use) => { await use(); throw new Error('test'); } }), {});
  await worker.beginAttempt({}).run(({ test }) => {});
  const close = worker.close(); assert.equal(worker.close(), close);
  await assert.rejects(close, error => { assert.deepEqual(error.errors.map(e => e.message), ['test', 'worker']); return true; });
});


test('option names that coincide with object prototype keys remain ordinary fixtures', async () => {
  const definitions = Object.fromEntries([['__proto__', ['default', { option: true }]]]);
  const configurationUse = Object.fromEntries([['__proto__', 'configured']]);
  const pool = new FixturePool(definitions, { configurationUse });
  const worker = new FixtureWorker(pool, {});
  assert.deepEqual(await worker.beginAttempt({}).run(({ __proto__ }) => __proto__), { ran: true, value: 'configured' });
  await worker.close();
});
