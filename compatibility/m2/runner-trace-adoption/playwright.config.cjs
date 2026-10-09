module.exports = {
  testDir: __dirname,
  workers: 1,
  retries: 1,
  timeout: 10000,
  outputDir: process.env.FLASHWRIGHT_ADOPTION_OUTPUT,
  reporter: [['json', { outputFile: process.env.FLASHWRIGHT_ADOPTION_RESULTS }]],
  projects: ['on', 'retain-on-failure', 'on-first-retry', 'on-all-retries', 'retain-on-first-failure', 'retain-on-failure-and-retries', 'retry-with-trace', 'off'].map(mode => ({ name: mode, use: { trace: { mode, sources: true, attachments: true } } })),
};
