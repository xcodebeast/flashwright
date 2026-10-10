const { test: originalTest, expect, chromium } = require('./coordinator-fixtures.cjs');
let optionPage;
const test = originalTest.extend({
  browserName: [async ({}, use) => {
    const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
    try {
      const context = await browser.newContext();
      optionPage = await context.newPage();
      await optionPage.evaluate(() => { document.title = 'worker option creation'; });
      await use('chromium');
    } finally { await browser.close(); }
  }, { scope: 'worker', option: true }],
});

test('worker option and stock page share original artifact ownership', async ({ page }) => {
  await expect(optionPage).toHaveTitle('worker option creation');
  await page.evaluate(() => { document.title = 'stock page after worker option'; });
  await expect(page).toHaveTitle('stock page after worker option');
});
