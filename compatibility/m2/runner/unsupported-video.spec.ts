import { test } from '@flashwright/test';
test.use({ video: 'on' });
test.fail();
test('unsupported artifact policy rejects before the test body', async ({ page }) => { await page.evaluate(() => { throw new Error('Unsupported artifact policy was silently ignored'); }); });
