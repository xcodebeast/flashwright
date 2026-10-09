import { defineConfig, devices } from '@flashwright/test';
import * as upstream from 'flashwright-upstream-runner';

if (process.env.FLASHWRIGHT_DEVICE_RUNNER === 'flashwright') {
  const forbidden = () => { throw new Error('Upstream browser backend must not be used by the native device runner'); };
  for (const browser of [upstream.chromium, upstream.firefox, upstream.webkit]) browser.launch = forbidden as never;
  upstream.request.newContext = forbidden as never;
}

export default defineConfig({
  testDir: '.', workers: 1, retries: 0, timeout: 15000,
  reporter: [['list'], ['json', { outputFile: process.env.FLASHWRIGHT_DEVICE_REPORT }]],
  use: { launchOptions: { executablePath: process.env.FLASHWRIGHT_BROWSER_PATH } },
  projects: [
    ...['Desktop Chrome', 'Desktop Chrome HiDPI', 'Pixel 7'].map(name => ({ name, testMatch: 'presets.spec.ts', use: { ...devices[name] } })),
    { name: 'options', testMatch: 'options.spec.ts' },
  ],
});
