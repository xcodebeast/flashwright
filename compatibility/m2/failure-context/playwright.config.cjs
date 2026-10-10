const { defineConfig } = require(process.env.FLASHWRIGHT_FAILURE_CONTEXT_ENGINE === 'playwright' ? '@playwright/test' : '@flashwright/test');
module.exports = defineConfig({
  testDir: __dirname, testMatch: 'artifacts.spec.cjs', workers: 1, retries: 1,
  timeout: 20000, expect: { timeout: 150 },
  outputDir: process.env.FLASHWRIGHT_FAILURE_CONTEXT_OUTPUT,
  reporter: [['json', { outputFile: process.env.FLASHWRIGHT_FAILURE_CONTEXT_REPORT }]],
  use: { launchOptions: { executablePath: process.env.FLASHWRIGHT_BROWSER_PATH }, screenshot: process.env.FLASHWRIGHT_FAILURE_CONTEXT_ARTIFACTS ? 'only-on-failure' : 'off', trace: process.env.FLASHWRIGHT_FAILURE_CONTEXT_ARTIFACTS ? 'on' : 'off', video: 'off' },
});
