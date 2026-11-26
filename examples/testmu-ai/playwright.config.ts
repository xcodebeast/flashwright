import { defineConfig, devices } from '@playwright/test';
import { version } from '@playwright/test/package.json';

/**
 * Runs the same tests on a local Chromium or on the TestMu AI cloud grid.
 * See https://www.testmuai.com/support/docs/playwright-testing/ for every capability.
 */
const capabilities = {
  browserName: 'Chrome',
  browserVersion: 'latest',
  'LT:Options': {
    platform: 'Windows 11',
    build: process.env.LT_BUILD_NAME || 'Flashwright example',
    name: 'TodoMVC',
    user: process.env.LT_USERNAME,
    accessKey: process.env.LT_ACCESS_KEY,
    /* The grid picks its Playwright server from this. It needs the upstream version,
       so drop the `-flashwright.N` suffix. */
    playwrightClientVersion: version.split('-')[0],
    network: true,
    video: true,
    console: true,
  },
};

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  reporter: 'list',

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      /* One grid session per worker: Flashwright connects each worker to the grid once
         and runs that worker's tests in the session, so set `workers` to the number of
         parallel sessions your plan allows. */
      name: 'testmu-chrome',
      use: {
        connectOptions: {
          wsEndpoint: `wss://cdp.lambdatest.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(capabilities))}`,
        },
      },
    },
  ],
});
