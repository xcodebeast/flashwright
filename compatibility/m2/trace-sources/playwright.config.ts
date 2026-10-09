import { defineConfig } from '@flashwright/test';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.*', workers: 1, timeout: 15000,
  outputDir: process.env.FLASHWRIGHT_SOURCE_OUTPUT,
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  reporter: [['json', { outputFile: process.env.FLASHWRIGHT_SOURCE_REPORT }]],
});
