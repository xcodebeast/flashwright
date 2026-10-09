import { defineConfig } from '@flashwright/test';

export default defineConfig({
  testDir: '.', testMatch: 'tracing.spec.ts', workers: 1, timeout: 15000,
  reporter: [['json', { outputFile: process.env.FLASHWRIGHT_TRACE_REPORT! }]],
  outputDir: process.env.FLASHWRIGHT_TRACE_OUTPUT!,
  use: {
    trace: 'off', video: 'off', screenshot: 'on',
    launchOptions: { executablePath: process.env.FLASHWRIGHT_BROWSER_PATH! },
  },
});
