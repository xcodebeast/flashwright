import { test, expect } from '@flashwright/test';
import { chromium, type Page } from 'flashwright';

async function inherited(page: Page) {
  await page.goto('/settings');
  expect(await page.evaluate(() => [matchMedia('(prefers-color-scheme:dark)').matches,
    matchMedia('(prefers-reduced-motion:reduce)').matches, matchMedia('(forced-colors:active)').matches,
    matchMedia('(prefers-contrast:more)').matches])).toEqual([true, true, true, true]);
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

test('fixture context receives individual settings over contextOptions', async ({ page, colorScheme }) => {
  expect(colorScheme).toBe('dark');
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


test.describe('individual media override', () => {
  test.use({ colorScheme: 'light' });
  test('overrides color scheme and preserves other nested preferences', async ({ page }) => {
    expect(await page.evaluate(() => [matchMedia('(prefers-color-scheme:light)').matches,
      matchMedia('(prefers-reduced-motion:reduce)').matches, matchMedia('(forced-colors:active)').matches,
      matchMedia('(prefers-contrast:more)').matches])).toEqual([true, true, true, true]);
  });
});

test('explicit media defaults suppress inherited context preferences', async ({ browser }) => {
  const page = await browser.newPage({ colorScheme: 'light', reducedMotion: 'no-preference', forcedColors: 'none', contrast: 'no-preference' });
  try {
    expect(await page.evaluate(() => [matchMedia('(prefers-color-scheme:light)').matches,
      matchMedia('(prefers-reduced-motion:reduce)').matches, matchMedia('(forced-colors:active)').matches,
      matchMedia('(prefers-contrast:more)').matches])).toEqual([true, false, false, false]);
  } finally { await page.close(); }
  // @ts-expect-error Deliberately verify JavaScript explicit-undefined suppression.
  const defaults = await browser.newPage({ colorScheme: undefined, reducedMotion: undefined, forcedColors: undefined, contrast: undefined });
  try {
    expect(await defaults.evaluate(() => [matchMedia('(prefers-color-scheme:light)').matches,
      matchMedia('(prefers-reduced-motion:reduce)').matches, matchMedia('(forced-colors:active)').matches,
      matchMedia('(prefers-contrast:more)').matches])).toEqual([true, false, false, false]);
  } finally { await defaults.close(); }
});


test.describe('environment color scheme', () => {
  test.use({ colorScheme: null });
  test('preserves null as an explicit fixture value', async ({ page, colorScheme, browser }) => {
    expect(colorScheme).toBeNull();
    const comparison = await browser.newPage({ colorScheme: null });
    try {
      expect(await page.evaluate(() => matchMedia('(prefers-color-scheme:dark)').matches))
        .toBe(await comparison.evaluate(() => matchMedia('(prefers-color-scheme:dark)').matches));
    } finally { await comparison.close(); }
  });
});
