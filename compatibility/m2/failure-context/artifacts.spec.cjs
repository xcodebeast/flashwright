const reference = process.env.FLASHWRIGHT_FAILURE_CONTEXT_ENGINE === 'playwright';
const { test, expect } = require(reference ? '@playwright/test' : '@flashwright/test');
const { chromium } = require(reference ? 'playwright' : 'flashwright');
const url = process.env.FLASHWRIGHT_FAILURE_CONTEXT_URL;

test('successful attempt has no failure document', async ({ page }) => {
  await page.goto(url);
  await expect(page.locator('button')).toHaveText('Original');
});
test('matcher observation supplies original diagnostic', async ({ page }) => {
  test.fail(); await page.goto(url);
  await expect.soft(page.locator('button')).toHaveText('Different');
  await page.evaluate(() => { document.querySelector('button').textContent = 'Later mutation'; });
});
test('generic failure captures first page body', async ({ page }) => {
  test.fail(); await page.goto(url); throw Error('Generic fixture failure');
});
test('count failure uses page fallback', async ({ page }) => {
  test.fail(); await page.goto(url); await expect(page.locator('button')).toHaveCount(9);
});
test('context close retains its original page', async ({ browser }) => {
  test.fail();
  const first = await browser.newContext(); const firstPage = await first.newPage();
  await firstPage.goto(url); expect.soft(1).toBe(2); await first.close();
  const successor = await browser.newContext(); const secondPage = await successor.newPage();
  await secondPage.goto(url + '/successor'); await successor.close();
});
test('ordinary page close has no fallback capture', async ({ page }) => {
  test.fail(); await page.goto(url); expect.soft(1).toBe(2); await page.close();
});
test('owned page close captures context fallback', async () => {
  test.fail();
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  try {
    const page = await browser.newPage(); await page.goto(url);
    expect.soft(1).toBe(2); await page.close();
  } finally { await browser.close(); }
});
test('direct browser close has no fallback capture', async () => {
  test.fail();
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  try { const page = await browser.newPage(); await page.goto(url); expect.soft(1).toBe(2); }
  finally { await browser.close(); }
});
test('browser-free failure still publishes document', async () => {
  test.fail(); throw Error('Browser-free fixture failure');
});
test('child frame fallback is a declared limitation', async ({ page }) => {
  test.fail(); await page.goto(url + '/frame'); throw Error('Framed fixture failure');
});
test('oversized fallback is explicitly bounded', async ({ page }) => {
  test.fail(); await page.goto(url);
  await page.evaluate(() => {
    for (let index = 0; index < 1500; index++) {
      const button = document.createElement('button'); button.textContent = `Diagnostic item ${index}`;
      document.body.appendChild(button);
    }
  });
  throw Error('Large fallback fixture failure');
});
test('retry does not inherit previous failure document', async ({ page }, testInfo) => {
  await page.goto(url);
  if (!testInfo.retry) throw Error('First attempt fixture failure');
  await expect(page.locator('button')).toHaveText('Original');
});


test.describe('hook ownership', () => {
  let context;
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext(); const page = await context.newPage(); await page.goto(url);
  });
  test.afterAll(async () => { await context.close(); });
  test('suite context survives hook scopes', async () => {
    test.fail(); throw Error('Failure after beforeAll fixture teardown');
  });
});

test.describe('late hook failure', () => {
  test.afterAll(async () => { throw Error('Failure from afterAll hook'); });
  test('afterAll error remains in final document', async ({ page }) => {
    test.fail(); await page.goto(url);
  });
});
