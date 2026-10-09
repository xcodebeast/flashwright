const modes = ['off', 'on', 'retain-on-failure', 'on-first-retry', 'on-all-retries', 'retain-on-first-failure', 'retain-on-failure-and-retries', 'retry-with-trace'];
module.exports = {
  testDir: '.', testMatch: 'start.spec.cjs', workers: 1, timeout: 5000, retries: 1,
  reporter: [['json', { outputFile: process.env.FLASHWRIGHT_START_RESULTS }]],
  outputDir: process.env.FLASHWRIGHT_START_OUTPUT,
  projects: process.env.FLASHWRIGHT_START_LIVE ? [{ name: 'live', use: { trace: { mode: 'on', live: true } } }] : [
    ...modes.map(mode => ({ name: mode, use: { trace: mode } })),
    { name: 'object defaults', use: { trace: { mode: 'on' } } },
    { name: 'explicit undefined', use: { trace: { mode: 'on', sources: undefined, attachments: undefined } } },
  ],
};
