import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixturePool } from '../packages/flashwright-runner/dist/commonjs/independent/fixture-pool.js';
import { SuiteCollector } from '../packages/flashwright-runner/dist/commonjs/independent/suite-collector.js';
import { runWorkerGroup } from '../packages/flashwright-runner/dist/commonjs/independent/suite-runtime.js';
import { suiteScenarios } from '../compatibility/runner-suite-core/scenarios.mjs';

const collect = async (declare, pool) => {
  const collector = new SuiteCollector(), api = collector.createTest(pool);
  await collector.collect('suite.spec.ts', () => declare(api));
  return collector.seal();
};

test('collection seals late declarations, depth-first order and nested fixture overrides', async () => {
  const events = [], scenario = suiteScenarios((name, event) => events.push(event))[0];
  const tests = await collect(scenario.declare);
  assert.deepEqual(tests.map(t => t.titlePath), [['first'], ['nested', 'nested-test'], ['last']]);
  assert.ok(Object.isFrozen(tests) && Object.isFrozen(tests[0]) && Object.isFrozen(tests[0].suites[0].hooks));
  const result = await runWorkerGroup(tests);
  assert.deepEqual(result.results.map(r => r.status), ['passed', 'passed', 'passed']);
  assert.deepEqual(result.pending, []); assert.deepEqual(result.teardownErrors, []);
  assert.ok(events.includes('first:outer') && events.includes('nested:inner') && events.includes('last:outer'));
  assert.ok(events.indexOf('inner-after-1:inner') < events.indexOf('inner-after-2:inner'));
});

test('invalid declarations and all fixture pools validate before any effects', async () => {
  let effects = 0;
  const pool = new FixturePool({ auto: [async ({}, use) => { effects++; await use(); }, { auto: true }] });
  await assert.rejects(collect(test => { test('first', () => {}); test('invalid', ({ missing }) => {}); }, pool), /unknown fixture/);
  await assert.rejects(collect(test => { test('same', () => {}); test('same', () => {}); }), /Duplicate/);
  for (const declaration of [test => test.describe.parallel('p', () => {}), test => test.describe.configure({ mode: 'serial' }), test => test.describe.configure({ retries: 1 }), test => test.skip(true), test => test.setTimeout(100)]) await assert.rejects(collect(declaration), /not implement|requires/);
  assert.equal(effects, 0);
  await assert.rejects(collect(test => { test.describe.configure({ mode: 'default' }); test.describe.configure({ mode: 'default' }); }), /already assigned/);
});

test('collection failure cannot yield a partial executable plan', async () => {
  const collector = new SuiteCollector(), api = collector.createTest();
  await assert.rejects(collector.collect('broken', () => { api('earlier', () => {}); throw new Error('import'); }), /import/);
  assert.throws(() => collector.seal(), /incomplete/);
  assert.throws(() => api('late', () => {}), /active file/);
});

test('late declarations retain original async ownership across imports', async () => {
  const collector = new SuiteCollector(), api = collector.createTest();
  let release, late;
  const gate = new Promise(resolve => release = resolve);
  await collector.collect('first', () => { api('first', () => {}); late = gate.then(() => api('leak', () => {})); });
  await collector.collect('second', async () => {
    await assert.rejects(collector.collect('overlap', () => {}), /another file/);
    release(); await assert.rejects(late, /active file/); api('second', () => {});
  });
  assert.deepEqual(collector.seal().map(t => t.title), ['first', 'second']);
});

test('async describe rejects and never attaches its continuation to the parent', async () => {
  const collector = new SuiteCollector(), api = collector.createTest();
  let release, continuation;
  const gate = new Promise(resolve => release = resolve);
  await assert.rejects(collector.collect('async', () => api.describe('invalid', () => {
    continuation = gate.then(() => api('late', () => {})); return continuation;
  })), /Async describe/);
  release(); await assert.rejects(continuation, /active file/);
  assert.throws(() => collector.seal(), /incomplete/);
});

test('beforeEach failures run later hooks and all cleanup, but suppress the body', async () => {
  const events = [], scenario = suiteScenarios((name, event) => events.push(event)).find(s => s.name === 'before-each-errors');
  const result = await runWorkerGroup(await collect(scenario.declare));
  assert.deepEqual(events, ['outer-before-1', 'outer-before-2', 'inner-before', 'inner-after-1', 'inner-after-2', 'outer-after', 'outer-afterAll']);
  assert.deepEqual(result.results[0].errors.map(e => e.phase), ['beforeEach', 'afterEach']);
});

test('beforeAll failure retains its suite, closes only entered suites and returns pending tests', async () => {
  const events = [], scenario = suiteScenarios((name, event) => events.push(event)).find(s => s.name === 'before-all-errors');
  const result = await runWorkerGroup(await collect(scenario.declare));
  assert.deepEqual(events, ['outer-beforeAll-1', 'outer-beforeAll-2', 'outer-afterAll']);
  assert.equal(result.results.length, 1); assert.equal(result.results[0].status, 'failed');
  assert.equal(result.failedBeforeAll.title, ''); assert.deepEqual(result.pending.map(t => t.title), ['blocked']);
});

test('inner afterAll failure retires shared ancestors before stopping the group', async () => {
  const events = [], tests = await collect(test => {
    test.beforeAll(() => events.push('outer-before'));
    test.afterAll(() => events.push('outer-after'));
    test.describe('inner', () => {
      test('first', () => events.push('body'));
      test.afterAll(() => { events.push('inner-after-1'); throw new Error('cleanup'); });
      test.afterAll(() => events.push('inner-after-2'));
    });
    test('pending', () => events.push('must-not-run'));
  });
  const result = await runWorkerGroup(tests);
  assert.deepEqual(events, ['outer-before', 'body', 'inner-after-1', 'inner-after-2', 'outer-after']);
  assert.equal(result.results[0].status, 'failed'); assert.equal(result.pending[0].title, 'pending');
});

test('an expected beforeAll failure preserves active suites and permits later tests', async () => {
  const events = [], scenario = suiteScenarios((name, event) => events.push(event)).find(s => s.name === 'expected-before-all-failure');
  const result = await runWorkerGroup(await collect(scenario.declare));
  assert.deepEqual(result.results.map(r => r.status), ['failed', 'passed']);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(events, ['beforeAll', 'inner-beforeAll', 'continue', 'inner-afterAll', 'afterAll']);
});

test('body and every cleanup failure survive in phase-specific results', async () => {
  const scenario = suiteScenarios(() => {}).find(s => s.name === 'body-and-cleanup-errors');
  const result = await runWorkerGroup(await collect(scenario.declare));
  assert.deepEqual(result.results[0].errors.map(e => [e.phase, e.error.message]), [['body', 'body sentinel'], ['afterEach', 'afterEach sentinel'], ['testTeardown', 'fixture sentinel'], ['afterAll', 'afterAll sentinel']]);
});

test('expected failures continue, unexpected passes stop and static skips have no effects', async () => {
  const events = [], tests = await collect(test => {
    test.skip('skipped', () => events.push('must-not-run'));
    test.fail('expected', () => { events.push('expected'); throw undefined; });
    test.fail('unexpected', () => events.push('unexpected'));
    test('pending', () => events.push('must-not-run-pending'));
  });
  const result = await runWorkerGroup(tests);
  assert.deepEqual(result.results.map(r => r.status), ['skipped', 'failed', 'passed']);
  assert.deepEqual(events, ['expected', 'unexpected']); assert.equal(result.pending.length, 1);
  assert.equal(result.results[1].errors[0].error, undefined);
});

test('worker cleanup attribution distinguishes ordinary shutdown from failure shutdown', async () => {
  const pool = new FixturePool({ w: [async ({}, use) => { await use(); throw new Error('worker cleanup'); }, { scope: 'worker', auto: true }] });
  for (const fail of [false, true]) {
    const tests = await collect(test => test('body', () => { if (fail) throw new Error('body'); }), pool);
    const result = await runWorkerGroup(tests);
    assert.equal(result.results[0].status, fail ? 'failed' : 'passed');
    assert.deepEqual(result.teardownErrors.map(e => e.error.message), fail ? [] : ['worker cleanup']);
    assert.deepEqual(result.results[0].errors.map(e => e.phase), fail ? ['body', 'workerTeardown'] : []);
  }
});

test('incompatible workers reject the complete group before an earlier test starts', async () => {
  let effects = 0;
  const tests = await collect(base => {
    const first = base.extend({ w: [1, { scope: 'worker' }] }), second = base.extend({ w: [2, { scope: 'worker' }] });
    first('first', () => effects++); second('second', () => effects++);
  });
  await assert.rejects(runWorkerGroup(tests), /fresh worker/); assert.equal(effects, 0);
});

test('an ancestor hook cannot acquire a fixture introduced only by child use', async () => {
  await assert.rejects(collect(test => {
    test.beforeEach(({ childOnly }) => {});
    test.describe('child', () => { test.use({ childOnly: 1 }); test('body', () => {}); });
  }), /unknown fixture/);
});
