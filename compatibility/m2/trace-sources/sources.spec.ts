import { test, expect } from '@flashwright/test';
test('manual source capture from packed TypeScript', async ({ context, page }, testInfo) => {
  await context.tracing.start({ sources: true, screenshots: false, snapshots: false });
  const value = await page.evaluate(() => 42);
  expect(value).toBe(42);
  const path = testInfo.outputPath('manual-sources.zip');
  await context.tracing.stop({ path });
  await testInfo.attach('manual sources', { path, contentType: 'application/zip' });
});
