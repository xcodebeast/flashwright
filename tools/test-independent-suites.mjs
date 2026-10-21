import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixturePool } from '../packages/flashwright-runner/dist/commonjs/independent/fixture-pool.js';
import { SuiteCollector } from '../packages/flashwright-runner/dist/commonjs/independent/suite-collector.js';
import { SuiteWorker, currentFiniteTestInfo, runWorkerGroup } from '../packages/flashwright-runner/dist/commonjs/independent/suite-runtime.js';
import { groupTests } from '../packages/flashwright-runner/dist/commonjs/independent/suite-groups.js';
import { suiteScenarios } from '../compatibility/runner-suite-core/scenarios.mjs';

const collect = async (declare, pool) => {
  const collector = new SuiteCollector(), api = collector.createTest(pool);
  await collector.collect('suite.spec.ts', () => declare(api));
  return collector.seal();
};

test('collection seals late declarations, depth-first order and nested fixture overrides', async () => {
  const events = [], scenario = suiteScenarios((name, event) => events.push(event)).find(s => s.name === 'late-nested-declarations');
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
  for (const declaration of [test => test.describe.serial('p', () => {}), test => test.describe.configure({ mode: 'serial' }), test => test.describe.configure({ retries: 1 }), test => test.skip(true), test => test.setTimeout(100)]) await assert.rejects(collect(declaration), /not implement|requires/);
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

test('parallel groups preserve sequential islands and balance all-hook chunks', async () => {
  const tests = await collect(test => {
    test.describe.parallel('parallel', () => {
      test.beforeAll(() => {});
      for (let i = 0; i < 8; i++) test('p' + i, () => {});
      test.describe('default', () => {
        test.describe.configure({ mode: 'default' });
        test('s1', () => {}); test('s2', () => {});
      });
    });
    test('general', () => {});
  });
  assert.deepEqual(groupTests(tests, 1).map(g => g.tests.map(t => t.title)), [['general'], ['s1', 's2'], ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']]);
  assert.deepEqual(groupTests(tests, 4).map(g => g.tests.map(t => t.title)), [['general'], ['s1', 's2'], ['p0', 'p1'], ['p2', 'p3'], ['p4', 'p5'], ['p6', 'p7']]);
  await assert.rejects(collect(test => { test.describe.configure({ mode: 'default' }); test.describe.parallel('bad', () => {}); }), /cannot be nested/);
  for (const workers of [0, -1, NaN, 1.5]) assert.throws(() => groupTests(tests, workers), /positive integer/);
});

test('successful groups reuse worker fixtures and reenter all-hooks', async () => {
  const events = [];
  const tests = await collect(base => {
    const test = base.extend({ w: [async ({}, use) => { events.push('setup'); await use(7); events.push('teardown'); }, { scope: 'worker' }] });
    test.beforeAll(({ w }) => events.push('before:' + w));
    test.afterAll(({ w }) => events.push('after:' + w));
    test('general', ({ w }) => events.push('general:' + w));
    test.describe.parallel('p', () => { test('parallel', ({ w }) => events.push('parallel:' + w)); });
  });
  const groups = groupTests(tests, 1), worker = new SuiteWorker(tests[0].pool);
  for (const group of groups) assert.ok((await worker.run(group.tests)).results.every(r => r.status === 'passed'));
  assert.deepEqual(events, ['setup', 'before:7', 'general:7', 'after:7', 'before:7', 'parallel:7', 'after:7']);
  assert.deepEqual(await worker.close(), []); assert.equal(events.at(-1), 'teardown');
  await assert.rejects(worker.run(groups[0].tests), /retired/);
});

test('close owns pending group callbacks and retired workers reject reuse', async () => {
  let release; const pending = new Promise(resolve => release = resolve), events = [];
  const tests = await collect(test => test('held', async () => { events.push('start'); await pending; events.push('end'); }));
  const worker = new SuiteWorker(tests[0].pool), run = worker.run(tests);
  while (!events.length) await Promise.resolve();
  await assert.rejects(worker.run(tests), /busy/);
  const close = worker.close(); assert.equal(close, worker.close());
  let closed = false; void close.then(() => closed = true);
  await Promise.resolve(); assert.equal(closed, false);
  release(); await run; await close; assert.deepEqual(events, ['start', 'end']);
  const failedTests = await collect(test => test('failure', () => { throw new Error('fail'); }));
  const failed = new SuiteWorker(failedTests[0].pool);
  assert.equal((await failed.run(failedTests)).results[0].status, 'failed');
  await assert.rejects(failed.run(failedTests), /retired/); await failed.close();
});

test('test context follows callbacks and rejects late work from a prior attempt', async () => {
  let release, late;
  const pending = new Promise(resolve => release = resolve);
  const tests = await collect(test => {
    test('first', () => { assert.equal(currentFiniteTestInfo().title, 'first'); late = pending.then(() => currentFiniteTestInfo()); });
    test('second', async () => { release(); await assert.rejects(late, /No active/); assert.equal(currentFiniteTestInfo().title, 'second'); });
  });
  const result = await runWorkerGroup(tests);
  assert.deepEqual(result.results.map(r => r.status), ['passed', 'passed']);
  assert.throws(() => currentFiniteTestInfo(), /No active/);
});

test('group partition uses worker value identity and retains file boundaries', async () => {
  const collector = new SuiteCollector(), base = collector.createTest();
  const a = base.extend({ w: [{ x: 1 }, { scope: 'worker' }] }), b = base.extend({ w: [{ x: 1 }, { scope: 'worker' }] });
  await collector.collect('a', () => { a('a1', () => {}); b('b1', () => {}); a('a2', () => {}); });
  await collector.collect('b', () => a('a3', () => {}));
  assert.deepEqual(groupTests(collector.seal(), 4).map(g => [g.file, ...g.tests.map(t => t.title)]), [['a', 'a1', 'a2'], ['b', 'a3'], ['a', 'b1']]);
});

test('retirement remains sticky when teardown changes an unexpected pass into an expected failure', async () => {
  const tests = await collect(base => {
    const test = base.extend({ w: [async ({}, use) => { await use(); throw new Error('worker cleanup'); }, { scope: 'worker', auto: true }] });
    test.fail('unexpected pass', () => {});
  });
  const worker = new SuiteWorker(tests[0].pool), result = await worker.run(tests);
  assert.equal(result.results[0].status, 'failed'); assert.equal(result.results[0].expectedStatus, 'failed');
  assert.equal(result.workerStopped, true);
  await assert.rejects(worker.run(tests), /retired/);
  assert.deepEqual(await worker.close(), [], 'Failure cleanup errors belong only to the original result');
});

test('worker fixture teardown observes the failing attempt rather than its setup attempt', async () => {
  const events = [];
  const tests = await collect(base => {
    const test = base.extend({ w: [async ({}, use) => {
      events.push('setup:' + currentFiniteTestInfo().title); await use();
      events.push('teardown:' + currentFiniteTestInfo().title);
    }, { scope: 'worker', auto: true }] });
    test.describe.parallel('p', () => {
      test('first', () => {}); test('second', () => { throw new Error('body'); });
    });
  });
  const worker = new SuiteWorker(tests[0].pool), groups = groupTests(tests, 1);
  await worker.run(groups[0].tests);
  const result = await worker.run(groups[1].tests);
  assert.deepEqual(events, ['setup:first', 'teardown:second']);
  assert.deepEqual(result.results[0].errors.map(e => e.phase), ['body']);
  await worker.close();
});
