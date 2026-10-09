module.exports = {
  testDir: __dirname, testMatch: 'sources.spec.cjs', timeout: 15000, workers: 1, retries: 0,
  projects: [true, false].map(sources => ({ name: sources ? 'sources-on' : 'sources-off', use: { trace: { mode: 'on', sources, snapshots: false, screenshots: false, attachments: false } } })),
  outputDir: process.env.FLASHWRIGHT_SOURCE_OUTPUT,
  reporter: [['json', { outputFile: process.env.FLASHWRIGHT_SOURCE_RESULTS }]],
};
