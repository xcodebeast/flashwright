import { defineConfig } from '@flashwright/test';
import { chromium } from 'flashwright';
import * as upstream from 'flashwright-upstream-runner';

const forbiddenBrowser = () => { throw new Error('Request-only suite must not launch a browser'); };
chromium.launch = forbiddenBrowser;
for (const browser of [upstream.chromium, upstream.firefox, upstream.webkit]) browser.launch = forbiddenBrowser;
if (process.env.FLASHWRIGHT_REQUEST_ENGINE === 'flashwright') {
  upstream.request.newContext = async () => { throw new Error('Native request suite must not use the upstream request backend'); };
}

export default defineConfig({
  testDir: '.', testMatch: process.env.FLASHWRIGHT_REQUEST_LIFECYCLE_MODE === 'factory-timeout'
    ? 'late-creation.spec.ts' : process.env.FLASHWRIGHT_REQUEST_LIFECYCLE_MODE ? 'lifecycle.spec.ts' : 'request.spec.ts',
  workers: 1, retries: process.env.FLASHWRIGHT_REQUEST_LIFECYCLE_MODE === 'retry' ? 1 : 0,
  fullyParallel: false, timeout: 15000,
  reporter: [['list'], ['json', { outputFile: process.env.FLASHWRIGHT_REQUEST_RESULTS! }]],
  use: {
    baseURL: process.env.FLASHWRIGHT_REQUEST_ORIGIN!, actionTimeout: 120,
    storageState: process.env.FLASHWRIGHT_REQUEST_STORAGE!,
    contextOptions: { userAgent: 'RequestFixture/1.0', viewport: { width: 360, height: 240 }, hasTouch: true },
    trace: process.env.FLASHWRIGHT_REQUEST_LIFECYCLE_MODE === 'factory-timeout' ? 'on'
      : process.env.FLASHWRIGHT_REQUEST_LIFECYCLE_MODE === 'retry' ? 'on-first-retry' : 'off',
  },
});
