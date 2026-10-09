import { test, expect } from '@playwright/test';

test('manual snapshots compose with filmstrip, sources and runner screenshots', async ({ context, page }, testInfo) => {
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await page.goto(process.env.FLASHWRIGHT_FILMSTRIP_ORIGIN!);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#network-style')!).color)).toBe('rgb(20, 40, 60)');
  const result = await page.evaluate(async () => {
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;background:rgb(240,0,0)';
    for (let index = 0; index < 4; index++) {
      document.body.style.background = index % 2 ? 'rgb(240,0,0)' : 'rgb(239,0,0)';
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    return 42;
  });
  expect(result).toBe(42);
  const media = await page.evaluate(() => {
    const input = document.createElement('input'); input.type = 'file'; input.id = 'trace-upload';
    input.style.cssText = 'position:fixed;left:30px;top:30px'; document.body.append(input);
    return { light: matchMedia('(prefers-color-scheme:light)').matches, contrast: matchMedia('(prefers-contrast:more)').matches };
  });
  expect(media).toEqual({ light: true, contrast: false });
  const opening = page.waitForEvent('filechooser');
  await page.locator('#trace-upload').click();
  const chooser = await opening;
  await chooser.setFiles({ name: 'bytes.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 255, 128, 13]) });
  expect(await chooser.element().evaluate(async element => Array.from(new Uint8Array(await (element as HTMLInputElement).files![0].arrayBuffer())))).toEqual([0, 255, 128, 13]);
  await chooser.element().dispose();
  const path = testInfo.outputPath('filmstrip.zip');
  await context.tracing.stop({ path });
  await testInfo.attach('manual filmstrip', { path, contentType: 'application/zip' });
});
