import { defineConfig } from '@flashwright/test';
import { resolve } from 'node:path';
export default defineConfig({
  testDir: '.', workers: 1, retries: 1, timeout: 10000,
  use: { baseURL: process.env.FLASHWRIGHT_TEST_BASE_URL },
  reporter: [['list'], ['json', { outputFile: resolve('test-results/native-runner.json') }]],
});
