import { defineConfig } from './adapter.js';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: '.', testMatch: 'boundary.spec.ts', workers: 1, retries: 1,
  timeout: 10000,
  reporter: [['list'], ['json', { outputFile: resolve('test-results/runner-boundary.json') }]],
});
