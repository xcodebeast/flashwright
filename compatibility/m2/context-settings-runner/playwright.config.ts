import { defineConfig } from '@flashwright/test';
import * as upstream from 'flashwright-upstream-runner';

if (process.env.FLASHWRIGHT_SETTINGS_ENGINE === 'flashwright') {
  const forbidden = () => { throw new Error('Native runner must not launch an upstream browser'); };
  for (const browser of [upstream.chromium, upstream.firefox, upstream.webkit]) browser.launch = forbidden as never;
}

export default defineConfig({
  testDir: '.', workers: 1, retries: 0, timeout: 15000,
  reporter: [['list'], ['json', { outputFile: process.env.FLASHWRIGHT_SETTINGS_RESULTS! }]],
  use: {
    launchOptions: { executablePath: process.env.FLASHWRIGHT_BROWSER_PATH!, slowMo: 0 },
    baseURL: process.env.FLASHWRIGHT_SETTINGS_SECURE_ORIGIN!,
    contextOptions: { ignoreHTTPSErrors: false, javaScriptEnabled: true, colorScheme: 'light', reducedMotion: 'reduce', forcedColors: 'active', contrast: 'more' },
    ignoreHTTPSErrors: true, javaScriptEnabled: false, colorScheme: 'dark',
  },
});
