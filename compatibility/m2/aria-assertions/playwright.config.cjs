const { defineConfig } = require(process.env.FLASHWRIGHT_ARIA_ENGINE === 'playwright' ? '@playwright/test' : '@flashwright/test');
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: process.env.FLASHWRIGHT_ARIA_TEST ?? 'assertions.spec.cjs',
  workers: 1,
  retries: Number(process.env.FLASHWRIGHT_ARIA_RETRIES ?? 0),
  timeout: 10000,
  expect: { timeout: Number(process.env.FLASHWRIGHT_ARIA_TIMEOUT ?? 1000), ...(process.env.FLASHWRIGHT_ARIA_CHILDREN ? { toMatchAriaSnapshot: { children: process.env.FLASHWRIGHT_ARIA_CHILDREN } } : {}) },
  updateSnapshots: process.env.FLASHWRIGHT_ARIA_UPDATE ?? 'none',
  updateSourceMethod: 'patch',
  ignoreSnapshots: process.env.FLASHWRIGHT_ARIA_IGNORE === '1',
  snapshotPathTemplate: process.env.FLASHWRIGHT_ARIA_BASELINES ? `${process.env.FLASHWRIGHT_ARIA_BASELINES}/{arg}{ext}` : undefined,
  outputDir: process.env.FLASHWRIGHT_ARIA_OUTPUT,
  reporter: [['json', { outputFile: process.env.FLASHWRIGHT_ARIA_REPORT }]],
  use: { launchOptions: { executablePath: process.env.FLASHWRIGHT_BROWSER_PATH }, trace: 'off', screenshot: 'off', video: 'off' },
});
