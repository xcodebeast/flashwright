import { test, expect, devices } from '@flashwright/test';

test('generated device project reaches the native context and later pages', async ({ page, context }, testInfo) => {
  const profile = devices[testInfo.project.name];
  for (const current of [page, await context.newPage()]) {
    await current.goto(process.env.FLASHWRIGHT_TEST_BASE_URL!);
    const actual = await current.evaluate(() => ({ userAgent: navigator.userAgent, ratio: devicePixelRatio, touch: navigator.maxTouchPoints, width: screen.width, height: screen.height }));
    expect(actual).toEqual({ userAgent: profile.userAgent, ratio: profile.deviceScaleFactor, touch: profile.hasTouch ? 1 : 0, width: profile.viewport.width, height: profile.viewport.height });
    const image = await current.screenshot({ scale: 'css' });
    expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([profile.viewport.width, profile.viewport.height]);
  }
});
