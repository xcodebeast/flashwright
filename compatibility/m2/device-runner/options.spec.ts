import { test, expect } from '@flashwright/test';

test.use({ contextOptions: { userAgent: 'InheritedContext/1.0', deviceScaleFactor: 2, hasTouch: true, isMobile: true, viewport: { width: 320, height: 240 }, screen: { width: 500, height: 700 } } });

test('context options feed device fixtures', async ({ page }) => {
  await page.goto(process.env.FLASHWRIGHT_TEST_BASE_URL!);
  expect(await page.evaluate(() => ({ userAgent: navigator.userAgent, ratio: devicePixelRatio, touch: navigator.maxTouchPoints, orientation: screen.orientation.type, width: screen.width }))).toEqual({ userAgent: 'InheritedContext/1.0', ratio: 2, touch: 1, orientation: 'portrait-primary', width: 500 });
});

test.describe('individual options override inherited context options', () => {
  test.use({ userAgent: 'ExplicitOption/1.0', deviceScaleFactor: 1, hasTouch: false, isMobile: false });
  test('explicit false and scale one are preserved', async ({ page }) => {
    await page.goto(process.env.FLASHWRIGHT_TEST_BASE_URL!);
    expect(await page.evaluate(() => ({ userAgent: navigator.userAgent, ratio: devicePixelRatio, touch: navigator.maxTouchPoints, orientation: screen.orientation.type, width: screen.width }))).toEqual({ userAgent: 'ExplicitOption/1.0', ratio: 1, touch: 0, orientation: 'landscape-primary', width: 500 });
  });
});
