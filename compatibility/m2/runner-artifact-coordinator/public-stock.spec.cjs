const { test, expect } = require('./coordinator-fixtures.cjs');

test('stock page fixture captures assertions and attachments', async ({ page }, information) => {
  await test.step('stock fixture parent', async () => {
    await page.evaluate(() => { document.title = 'stock traced page'; });
    await expect(page).toHaveTitle('stock traced page');
  });
  await information.attach('original body', { body: Buffer.from('original attachment bytes'), contentType: 'text/plain' });
});

test('stock successor owns its own page and recording', async ({ page }) => {
  await expect(page).toHaveTitle('');
  await page.evaluate(() => { document.title = 'stock successor'; });
  await expect(page).toHaveTitle('stock successor');
});
