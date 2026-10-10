const assert = require('node:assert/strict');
const { test: artifactTest, chromium } = require('./coordinator-fixtures.cjs');
const test = artifactTest.extend({
  browser: [async ({}, use) => {
    const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: 'worker' }],
  context: async ({ browser }, use) => {
    const context = await browser.newContext();
    try { await use(context); } finally { await context.close(); }
  },
  page: async ({ context }, use) => { await use(await context.newPage()); },
});

test.beforeEach(async ({ page }) => { await page.evaluate(() => { document.title = 'original policy attempt'; }); });
test.afterEach(async ({ page }) => { assert.equal(await page.title(), 'original policy attempt'); });
test('ordinary passing attempt', async ({ page }) => { assert.equal(await page.title(), 'original policy attempt'); });
test('flaky attempt retains original error through two retries', async ({ page }, information) => {
  assert.equal(await page.title(), 'original policy attempt');
  if (information.retry < 2) throw Error(`original flaky failure ${information.retry}`);
});
test('expected failure preserves expected status', async ({ page }) => {
  test.fail();
  assert.equal(await page.title(), 'original policy attempt');
  throw Error('original expected failure');
});
test.skip('static skip never runs fixtures', async () => { throw Error('skipped body ran'); });
test.describe('timeout outcome', () => {
  test.describe.configure({ retries: 0 });
  test('original timeout survives capture and finalization', async ({ page }) => {
    assert.equal(await page.title(), 'original policy attempt');
    test.setTimeout(500);
    await new Promise(() => {});
  });
  test('passing predecessor starts worker before final skip', async ({ page }) => { assert.equal(await page.title(), 'original policy attempt'); });
  test.skip('final skip reaches original trace stop without fixtures', async () => { throw Error('final skipped body ran'); });
});
