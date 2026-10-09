import { test, expect, type Page, type BrowserContext } from '@flashwright/test';
import { chromium } from 'flashwright';

async function paint(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const mode of ['off', 'on', 'failure']) {
  test(`passing @${mode}`, async ({ page }) => { await paint(page); });
  test(`unexpected failure @${mode}`, async ({ page }) => {
    await paint(page);
    expect('actual').toBe('intentional-failure');
  });
  test(`expected failure @${mode}`, async ({ page }) => {
    test.fail();
    await paint(page);
    expect('actual').toBe('intentional-failure');
  });
}

test('unexpected pass @failure', async ({ page }) => { test.fail(); await paint(page); });
test('retry policy @first', async ({ page }, testInfo) => {
  await paint(page);
  expect(testInfo.retry).toBe(1);
});
test('second failure @first', async ({ page }) => { await paint(page); expect(false).toBe(true); });
test('full page options @options', async ({ page }) => { await paint(page); });

test('early context close retained @failure', async ({ browser }) => {
  const context = await browser.newContext();
  await paint(await context.newPage());
  await paint(await context.newPage());
  await context.close();
  expect(false).toBe(true);
});
test('early context close discarded @failure', async ({ browser }) => {
  const context = await browser.newContext();
  await paint(await context.newPage());
  await context.close();
});
test('owned page close retained @on', async ({ browser }) => {
  const page = await browser.newPage();
  await paint(page);
  await page.close();
});
test('ordinary page close is not captured @on', async ({ context }) => {
  const page = await context.newPage();
  await paint(page);
  await page.close();
});
test('direct browser close is not captured @on', async ({}) => {
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH! });
  await paint(await browser.newPage({ viewport: { width: 160, height: 120 }, baseURL: process.env.FLASHWRIGHT_TEST_BASE_URL! }));
  await browser.close();
});
test('manual browser context retained @failure', async ({}) => {
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH! });
  try {
    const context = await browser.newContext({ viewport: { width: 160, height: 120 }, baseURL: process.env.FLASHWRIGHT_TEST_BASE_URL! });
    await paint(await context.newPage());
    await context.close();
  } finally { await browser.close(); }
  expect(false).toBe(true);
});

const lateFailure = test.extend<{ lateFailure: void }>({
  lateFailure: [async ({ browser }, use) => {
    void browser;
    await use();
    throw new Error('intentional late fixture failure');
  }, { auto: true }],
});
lateFailure('fixture teardown failure @failure', async ({ page }) => { await paint(page); });

test.describe('afterEach and deduplication', () => {
  test.afterEach(async ({ context }) => { await context.close(); throw new Error('intentional afterEach failure'); });
  test('afterEach failure @failure', async ({ page }) => { await paint(page); });
  test('failure captured once @failure', async ({ page }) => { await paint(page); expect(false).toBe(true); });
});

test.describe('shared beforeAll context', () => {
  let context: BrowserContext;
  let page: Page;
  test.beforeAll(async ({ browser }) => { context = await browser.newContext(); page = await context.newPage(); await paint(page); });
  test.afterAll(async () => { await context.close(); });
  test('shared context first @on', async () => { expect(page.isClosed()).toBe(false); });
  test('shared context second @on', async () => { expect(page.isClosed()).toBe(false); });
});


test('test timeout @failure', async ({ page }) => {
  await paint(page);
  test.setTimeout(1000);
  await new Promise(() => {});
});
test('page crash @failure', async ({ page }) => {
  await paint(page);
  await page.goto('chrome://crash', { timeout: 1000 }).catch(() => {});
  expect('crash outcome preserved').toBe('intentional-failure');
});
