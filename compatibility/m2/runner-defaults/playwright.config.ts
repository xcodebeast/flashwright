import { defineConfig } from '@flashwright/test';
import * as upstream from 'flashwright-upstream-runner';

if (process.env.FLASHWRIGHT_DEFAULTS_ENGINE === 'flashwright') {
  const forbidden = () => { throw new Error('Native runner must not launch an upstream browser'); };
  for (const browser of [upstream.chromium, upstream.firefox, upstream.webkit]) browser.launch = forbidden as never;
}

export default defineConfig({
  testDir: '.', workers: 1, retries: 0, timeout: 15000,
  reporter: [['list'], ['json', { outputFile: process.env.FLASHWRIGHT_DEFAULTS_RESULTS! }]],
  use: {
    launchOptions: { executablePath: process.env.FLASHWRIGHT_BROWSER_PATH! },
    baseURL: process.env.FLASHWRIGHT_DEFAULTS_ORIGIN!,
    actionTimeout: 120, navigationTimeout: 350,
    contextOptions: {
      userAgent: 'RunnerContext/1.0', viewport: { width: 360, height: 240 },
      deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      storageState: { cookies: [{ name: 'runner-cookie', value: 'inherited', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] },
    },
  },
});
