import { test, expect } from '@flashwright/test';
import { chromium, type Page } from 'flashwright';

async function inherited(page: Page) {
  await page.goto('/settings');
  await expect(page.locator('#ready')).toHaveText('Ready');
  await expect(page.locator('#no-script')).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(globalThis, 'inlineRuns') ?? 0)).toBe(0);
  await page.locator('#action').click();
  expect(await page.evaluate(() => Reflect.get(globalThis, 'clicks') ?? 0)).toBe(0);
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try { await inherited(page); } finally { await page.close(); }
});
test.afterAll(async ({ browser }) => {
  const context = await browser.newContext();
  try { await inherited(await context.newPage()); } finally { await context.close(); }
});

test('fixture context receives individual settings over contextOptions', async ({ page }) => {
  await inherited(page);
});

test('manual contexts and owned pages inherit settings', async ({ browser }) => {
  const context = await browser.newContext();
  try { await inherited(await context.newPage()); } finally { await context.close(); }
  const page = await browser.newPage();
  try { await inherited(page); } finally { await page.close(); }
});

test('explicit settings and undefined suppress inherited values', async ({ browser }) => {
  const strict = await browser.newPage({ ignoreHTTPSErrors: false, javaScriptEnabled: true });
  try {
    await strict.goto(process.env.FLASHWRIGHT_SETTINGS_ORIGIN! + '/plain');
    expect(await strict.evaluate(() => Reflect.get(globalThis, 'inlineRuns'))).toBe(1);
    await expect(strict.goto('/strict')).rejects.toThrow(/ERR_CERT_/);
  } finally { await strict.close(); }
  const options = { ignoreHTTPSErrors: undefined, javaScriptEnabled: undefined };
  // @ts-expect-error Deliberately exercise JavaScript's explicit-undefined override despite the pinned exact optional declarations.
  const defaults = await browser.newPage(options);
  try {
    await defaults.goto(process.env.FLASHWRIGHT_SETTINGS_ORIGIN! + '/plain');
    expect(await defaults.evaluate(() => Reflect.get(globalThis, 'inlineRuns'))).toBe(1);
    expect(options).toEqual({ ignoreHTTPSErrors: undefined, javaScriptEnabled: undefined });
    await expect(defaults.goto('/default')).rejects.toThrow(/ERR_CERT_/);
  } finally { await defaults.close(); }
});

test('separately launched browsers inherit the active runner settings', async () => {
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH!, slowMo: 0 });
  try { await inherited(await browser.newPage()); } finally { await browser.close(); }
});

test.describe('per-test JavaScript override', () => {
  test.use({ javaScriptEnabled: true });
  test('keeps inherited HTTPS policy while enabling application scripts', async ({ page }) => {
    await page.goto('/enabled');
    expect(await page.evaluate(() => Reflect.get(globalThis, 'inlineRuns'))).toBe(1);
    await page.locator('#action').click();
    expect(await page.evaluate(() => Reflect.get(globalThis, 'clicks'))).toBe(1);
  });
});

test('the next test restores configured context settings', async ({ page }) => {
  await inherited(page);
});
