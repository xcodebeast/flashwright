import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.', testMatch: /filmstrip.*\.spec\.[cm]?ts/, workers: 1, timeout: 15000,
  reporter: [['json', { outputFile: process.env.FLASHWRIGHT_FILMSTRIP_REPORT! }]],
  outputDir: process.env.FLASHWRIGHT_FILMSTRIP_OUTPUT!,
  use: { trace: 'off', video: 'off', screenshot: 'on', launchOptions: { executablePath: process.env.FLASHWRIGHT_BROWSER_PATH! } },
});
