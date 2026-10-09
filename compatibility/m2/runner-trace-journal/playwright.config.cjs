module.exports = {
  testDir: __dirname,
  workers: 1,
  retries: 0,
  timeout: 10000,
  outputDir: process.env.FLASHWRIGHT_JOURNAL_OUTPUT,
  reporter: [['json', { outputFile: process.env.FLASHWRIGHT_JOURNAL_RESULTS }]],
  projects: [
    { name: 'complete', use: { trace: 'on' } },
    { name: 'no-attachments', use: { trace: { mode: 'on', attachments: false } } },
    { name: 'no-sources', use: { trace: { mode: 'on', sources: false } } },
    { name: 'events-only', use: { trace: { mode: 'on', sources: false, attachments: false } } },
  ],
};
