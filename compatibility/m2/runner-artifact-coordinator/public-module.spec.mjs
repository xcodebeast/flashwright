import fixtures from './coordinator-fixtures.cjs';
const { test, expect, chromium } = fixtures;
const browser = process.env.TEST_WORKER_INDEX === undefined ? undefined : await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
const context = await browser?.newContext();
const page = await context?.newPage();
if (page) await page.evaluate(() => { document.title = 'module original context'; });

test.afterAll(async () => { await browser?.close(); });
test('existing module context is enrolled before test actions', async () => {
  await expect(page).toHaveTitle('module original context');
});
