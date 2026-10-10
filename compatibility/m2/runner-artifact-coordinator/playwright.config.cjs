const api = process.env.FLASHWRIGHT_COORDINATOR_API === '1';
const publicRunner = process.env.FLASHWRIGHT_COORDINATOR_PUBLIC === '1';
const publicFixtures = process.env.FLASHWRIGHT_COORDINATOR_FIXTURES === '1';
const policies = process.env.FLASHWRIGHT_COORDINATOR_POLICIES === '1';
const interruption = process.env.FLASHWRIGHT_COORDINATOR_INTERRUPTION === '1';
module.exports = {
  testDir: __dirname, testMatch: api ? 'api.spec.cjs' : publicFixtures ? 'public-*.spec.*js' : interruption ? 'interruption.spec.cjs' : policies ? 'policies.spec.cjs' : 'coordinator.spec.cjs', timeout: 20000, workers: 1, retries: policies ? 2 : 0,
  projects: interruption ? [{ name: 'on', use: { screenshot: 'only-on-failure', trace: { mode: 'on', snapshots: true, screenshots: true, sources: false, attachments: true } } }] : policies
    ? ['off', 'on', 'retain-on-failure', 'on-first-retry', 'on-all-retries', 'retain-on-first-failure', 'retain-on-failure-and-retries', ...(publicRunner ? ['retry-with-trace'] : [])].map(mode => ({ name: mode, use: { screenshot: 'only-on-failure', trace: { mode, snapshots: mode === 'on', screenshots: mode === 'on', sources: false, attachments: true } } }))
    : [...[false, true].map(snapshots => ({ name: snapshots ? 'native-capture' : 'actions-only', use: { screenshot: snapshots ? 'on' : 'off', trace: { mode: 'on', snapshots, screenshots: snapshots, sources: true, attachments: true } } })), ...(publicFixtures ? [{ name: 'default-capture', use: { trace: 'on', screenshot: 'off' } }] : [])],
  outputDir: process.env.FLASHWRIGHT_COORDINATOR_OUTPUT,
  reporter: [...(interruption ? [[require.resolve('./interruption-reporter.cjs')]] : []), ['json', { outputFile: process.env.FLASHWRIGHT_COORDINATOR_RESULTS }]],
};
