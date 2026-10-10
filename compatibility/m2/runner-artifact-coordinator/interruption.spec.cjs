const assert = require('node:assert/strict');
const { test: artifactTest, chromium } = require('./coordinator-fixtures.cjs');
const test = artifactTest.extend({
  page: async ({}, use) => {
    const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
    try {
      const context = await browser.newContext();
      await use(await context.newPage());
    } finally { await browser.close(); }
  },
});

test('interruption preserves original status and finishes owned artifacts', async ({ page }) => {
  await page.evaluate(() => { document.title = 'interrupted original attempt'; });
  assert.equal(await page.title(), 'interrupted original attempt');
  // The harness signals the runner only after native capture and an action are ready.
  process.stdout.write('FLASHWRIGHT_INTERRUPT_READY\n');
  await new Promise(() => {});
});
