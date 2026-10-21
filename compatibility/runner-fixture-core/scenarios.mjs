import assert from 'node:assert/strict';

// Both implementations execute these exact callbacks. Observations describe
// application-owned setup/use/cleanup, rather than runner-internal events.
export function fixtureScenarios(record) {
  const log = (scenario, event) => record(scenario, event);
  return [
    {
      name: 'forward-extension',
      layers: [{ item: async ({ later }, use) => { log('forward-extension', 'setup'); await use(later); log('forward-extension', 'teardown'); } }, { later: 17 }],
      tests: [async ({ item }) => { assert.equal(item, 17); log('forward-extension', 'body'); }],
    },
    {
      name: 'diamond-and-auto',
      layers: [{
        workerAuto: [async ({}, use, info) => { assert.equal('retry' in info, false); log('diamond-and-auto', 'worker+'); await use(); log('diamond-and-auto', 'worker-'); }, { scope: 'worker', auto: true }],
        testAuto: [async ({}, use) => { log('diamond-and-auto', 'auto+'); await use(); log('diamond-and-auto', 'auto-'); }, { auto: true }],
        root: async ({}, use) => { log('diamond-and-auto', 'root+'); await use('root'); log('diamond-and-auto', 'root-'); },
        left: async ({ root }, use) => { log('diamond-and-auto', 'left+'); await use(root + ':left'); log('diamond-and-auto', 'left-'); },
        right: async ({ root }, use) => { log('diamond-and-auto', 'right+'); await use(root + ':right'); log('diamond-and-auto', 'right-'); },
        unused: async ({}, use) => { log('diamond-and-auto', 'UNUSED'); await use(); },
      }],
      tests: [
        async ({ right, left }) => { assert.equal(right, 'root:right'); assert.equal(left, 'root:left'); log('diamond-and-auto', 'body1'); },
        async ({ left, right }) => { assert.equal(left, 'root:left'); assert.equal(right, 'root:right'); log('diamond-and-auto', 'body2'); },
      ],
    },
    {
      name: 'override-chain',
      layers: [
        { extra: 'initial', item: async ({ extra }, use) => { log('override-chain', 'base+'); await use(extra); log('override-chain', 'base-'); } },
        { item: async ({ item }, use) => { log('override-chain', 'middle+'); await use(item + ':middle'); log('override-chain', 'middle-'); } },
        { extra: 'final', item: async ({ item }, use) => { log('override-chain', 'top+'); await use(item + ':top'); log('override-chain', 'top-'); } },
      ],
      tests: [async ({ item }) => { assert.equal(item, 'final:middle:top'); log('override-chain', item); }],
    },
    {
      name: 'option-reset', configurationUse: { choice: 'configured' },
      layers: [{ choice: ['default', { option: true }] }, { choice: 'extended' }], use: { choice: undefined },
      tests: [async ({ choice }) => { assert.equal(choice, 'configured'); log('option-reset', choice); }],
    },
    {
      name: 'all-hook-scopes',
      layers: [{
        workerAuto: [async ({}, use) => { log('all-hook-scopes', 'worker+'); await use(); log('all-hook-scopes', 'worker-'); }, { scope: 'worker', auto: true }],
        allHooks: [async ({}, use) => { log('all-hook-scopes', 'all+'); await use(); log('all-hook-scopes', 'all-'); }, { auto: 'all-hooks-included' }],
        testAuto: [async ({}, use) => { log('all-hook-scopes', 'test+'); await use(); log('all-hook-scopes', 'test-'); }, { auto: true }],
      }],
      beforeAll: [async ({}) => log('all-hook-scopes', 'beforeAll1'), async ({}) => log('all-hook-scopes', 'beforeAll2')],
      beforeEach: [async ({}) => log('all-hook-scopes', 'beforeEach')],
      afterEach: [async ({}) => log('all-hook-scopes', 'afterEach')],
      afterAll: [async ({}) => log('all-hook-scopes', 'afterAll')],
      tests: [async ({}) => log('all-hook-scopes', 'body1'), async ({}) => log('all-hook-scopes', 'body2')],
    },
    {
      name: 'setup-failure',
      layers: [{
        root: async ({}, use) => { log('setup-failure', 'root+'); await use('root'); log('setup-failure', 'root-'); },
        failed: async ({ root }, use) => { assert.equal(root, 'root'); log('setup-failure', 'failed+'); throw new Error('fixture setup sentinel'); },
        dependent: async ({ failed }, use) => { log('setup-failure', 'DEPENDENT'); await use(failed); },
      }],
      afterEach: [async ({}) => log('setup-failure', 'afterEach')],
      tests: [async ({ dependent }) => { log('setup-failure', 'BODY'); }],
      expectedFailure: 'fixture setup sentinel',
    },
    {
      name: 'body-and-cleanup-errors',
      layers: [{
        root: async ({}, use) => { log('body-and-cleanup-errors', 'root+'); await use(); log('body-and-cleanup-errors', 'root-'); throw new Error('root teardown sentinel'); },
        leaf: async ({ root }, use) => { log('body-and-cleanup-errors', 'leaf+'); await use(); log('body-and-cleanup-errors', 'leaf-'); throw new Error('leaf teardown sentinel'); },
      }],
      afterEach: [async ({}) => log('body-and-cleanup-errors', 'afterEach')],
      tests: [async ({ leaf }) => { log('body-and-cleanup-errors', 'body'); throw new Error('body sentinel'); }],
      expectedFailure: 'body sentinel',
      candidateCleanupErrors: ['leaf teardown sentinel', 'root teardown sentinel'],
    },
    {
      name: 'missing-use',
      layers: [{ item: async ({}, use) => { log('missing-use', 'setup'); } }],
      afterEach: [async ({}) => log('missing-use', 'afterEach')],
      tests: [async ({ item }) => log('missing-use', 'BODY')], expectedFailure: 'use()',
    },
    {
      name: 'double-use',
      layers: [{ item: async ({}, use) => { log('double-use', 'setup'); await use(1); log('double-use', 'release'); await use(2); } }],
      tests: [async ({ item }) => { assert.equal(item, 1); log('double-use', 'body'); }],
      expectedFailure: 'fixture value for the second time', candidateCleanupErrors: ['called use() more than once'],
    },
    {
      name: 'destructuring-and-values',
      layers: [{ value: { nested: 'nested' }, list: [[1, 2, 3], {}], number: 42 }],
      tests: [async ({ value: { nested }, /* dependency order is retained */ number: renamed, list, }) => {
        assert.equal(nested, 'nested'); assert.equal(renamed, 42); assert.deepEqual(list, [1, 2, 3]); log('destructuring-and-values', 'body');
      }],
    },
  ];
}
