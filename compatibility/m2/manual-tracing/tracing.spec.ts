import { test, expect } from '@flashwright/test';

test('manual trace retains caller locations in the runner', async ({ context, page }, testInfo) => {
  await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
  expect(await page.evaluate(() => { console.log('runner trace diagnostic'); return 42; })).toBe(42);
  await expect(page.evaluate(() => { throw Error('original runner browser error'); })).rejects.toThrow('original runner browser error');
  const path = testInfo.outputPath('manual.zip');
  await context.tracing.stop({ path });
  await testInfo.attach('manual trace', { path, contentType: 'application/zip' });
});
