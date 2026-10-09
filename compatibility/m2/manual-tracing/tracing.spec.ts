import { test, expect } from '@flashwright/test';

test('manual trace retains caller locations in the runner', async ({ context, page }, testInfo) => {
  await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
  expect(await page.evaluate(() => { console.log('runner trace diagnostic'); return 42; })).toBe(42);
  await expect(page.evaluate(() => { throw Error('original runner browser error'); })).rejects.toThrow('original runner browser error');
  await expect(page).toHaveTitle('');
  await expect(page).not.toHaveTitle('different');
  await expect(page.locator('body')).toHaveCount(1);
  await expect(expect(page).toHaveTitle('missing', { timeout: 30 })).rejects.toThrow();
  await expect(expect(page).not.toHaveTitle('', { timeout: 30 })).rejects.toThrow();
  await expect(expect(page).toHaveTitle('a'.repeat(5000), { timeout: 30 })).rejects.toThrow();
  const path = testInfo.outputPath('manual.zip');
  await context.tracing.stop({ path });
  await testInfo.attach('manual trace', { path, contentType: 'application/zip' });
});
