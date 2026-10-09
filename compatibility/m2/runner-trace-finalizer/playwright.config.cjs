module.exports = {
  testDir: __dirname, testMatch: 'finalizer.spec.cjs', timeout: 2000, workers: 1, retries: 0,
  use: { trace: 'on' }, outputDir: process.env.FLASHWRIGHT_FINALIZER_OUTPUT,
  reporter: [['json', { outputFile: process.env.FLASHWRIGHT_FINALIZER_RESULTS }]],
};
