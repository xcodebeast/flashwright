import { test, expect } from '@flashwright/test';
import { chromium } from 'flashwright';

// Discovery imports this file too; only a worker owns the real module-lifetime browser.
// Top-level awaits finish before auto fixtures can install screenshot observation.
const moduleBrowser = process.env.TEST_WORKER_INDEX === undefined ? undefined : await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH! });
const moduleContext = await moduleBrowser?.newContext({ viewport: { width: 160, height: 120 }, baseURL: process.env.FLASHWRIGHT_TEST_BASE_URL! });
const modulePage = await moduleContext?.newPage();
if (modulePage) {
  await modulePage.goto('/');
  await modulePage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test.afterAll(async () => { await moduleBrowser?.close(); });
test('module evaluation context @on @off', async () => {
  expect(modulePage?.isClosed()).toBe(false);
});
