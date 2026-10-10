const { defineConfig } = require(process.env.FLASHWRIGHT_MATCHER_CONTEXT_ENGINE === 'playwright' ? '@playwright/test' : '@flashwright/test');
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'assertions.spec.cjs',
  workers: 1,
  retries: 0,
  timeout: 10000,
  expect: { timeout: 150 },
  updateSnapshots: 'none',
  outputDir: process.env.FLASHWRIGHT_MATCHER_CONTEXT_OUTPUT,
  reporter: [['json', { outputFile: process.env.FLASHWRIGHT_MATCHER_CONTEXT_REPORT }]],
  use: { launchOptions: { executablePath: process.env.FLASHWRIGHT_BROWSER_PATH }, screenshot: 'off', trace: 'off', video: 'off' },
});
