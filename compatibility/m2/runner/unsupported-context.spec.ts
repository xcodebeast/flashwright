import { test } from '@flashwright/test';
test.use({ locale: 'fr-FR' });
test.fail();
test('unsupported context options reject before the test body', async ({ page }) => { await page.evaluate(() => { throw new Error('Unsupported context option was silently ignored'); }); });
