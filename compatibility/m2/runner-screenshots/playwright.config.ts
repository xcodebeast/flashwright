import { defineConfig } from '@flashwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 15000,
  workers: 2,
  reporter: [['json', { outputFile: process.env.FLASHWRIGHT_SCREENSHOT_REPORT! }]],
  outputDir: process.env.FLASHWRIGHT_SCREENSHOT_OUTPUT!,
  use: {
    baseURL: process.env.FLASHWRIGHT_TEST_BASE_URL!,
    launchOptions: { executablePath: process.env.FLASHWRIGHT_BROWSER_PATH! },
    trace: 'off', video: 'off',
    viewport: { width: 160, height: 120 },
  },
  projects: [
    { name: 'off', grep: /@off\b/, use: { screenshot: 'off' } },
    { name: 'on', grep: /@on\b/, use: { screenshot: 'on' } },
    { name: 'failure', grep: /@failure\b/, use: { screenshot: 'only-on-failure' } },
    { name: 'first', grep: /@first\b/, retries: 1, use: { screenshot: 'on-first-failure' } },
    { name: 'options', grep: /@options\b/, use: { screenshot: { mode: 'on', fullPage: true, omitBackground: true } } },
  ],
});
