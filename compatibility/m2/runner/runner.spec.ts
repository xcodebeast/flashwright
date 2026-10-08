import { test, expect } from './fixtures.js';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

test.use({ greeting: 'custom' });
test('extended fixtures run native browser actions and assertions', async ({ page, pageObject, greeting, browser }) => {
  expect(greeting).toBe('custom'); expect(browser.contexts()).toHaveLength(1);
  await pageObject.submit(greeting);
  await expect(page.getByRole('status')).toHaveText('Saved custom');
  await expect(page).toHaveTitle('Runner fixture');
  await test.step('checkbox action', async () => { await page.getByLabel('Choice').check(); await expect(page.getByLabel('Choice')).toBeChecked(); });
});
test('fresh contexts isolate browser storage', async ({ page }) => {
  expect(await page.evaluate(() => localStorage.getItem('from-test'))).toBe(null);
  await page.evaluate(() => localStorage.setItem('from-test', 'value'));
});
test.describe('stored login state', () => {
  const origin = process.env.FLASHWRIGHT_TEST_BASE_URL!;
  test.use({ contextOptions: { storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 'fixture', value: 'context option' }] }] } } });
  test('context options restore state before page fixture', async ({ page }) => {
    expect(await page.evaluate(() => localStorage.getItem('fixture'))).toBe('context option');
  });
  test.describe('explicit state', () => {
    test.use({ storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 'fixture', value: 'explicit option' }] }] } });
    test('storage state option overrides context options', async ({ page }) => {
      expect(await page.evaluate(() => localStorage.getItem('fixture'))).toBe('explicit option');
    });
  });
  test.describe('file state', () => {
    test.use({ storageState: async ({}, use, testInfo) => {
      const path = testInfo.outputPath('state.json');
      await writeFile(path, JSON.stringify({ cookies: [], origins: [{ origin, localStorage: [{ name: 'fixture', value: 'file option' }] }] }));
      await use(path);
    } });
    test('file storage state restores through fixture override', async ({ page }) => {
      expect(await page.evaluate(() => localStorage.getItem('fixture'))).toBe('file option');
    });
  });
});
test('soft native assertion failures reach the reporter', async ({ page }, testInfo) => {
  test.fail();
  await expect.soft(page.getByRole('status')).toHaveText('impossible', { timeout: 80 });
  expect(testInfo.errors).toHaveLength(1);
  await expect(page.getByRole('status')).toHaveText('Ready');
});
test('configured native assertion reports received value and call site', async ({ page }) => {
  await expect(page.getByRole('status')).toHaveText('Ready');
  await assert.rejects(async () => { await expect.configure({ timeout: 200 })(page.getByRole('status')).toHaveText('impossible'); }, error => {
    const failure = error as Error & { matcherResult: { actual: unknown } };
    expect(failure.message).toContain('Ready'); expect(failure.message).toContain('impossible');
    expect(failure.stack).toContain('runner.spec.ts'); expect(failure.matcherResult.actual).toBe('Ready'); return true;
  });
  await expect(page.getByRole('status')).not.toHaveText('impossible');
});
test('runner retries use fresh fixture ownership', async ({ page }, testInfo) => {
  await expect(page.getByRole('status')).toHaveText('Ready');
  expect(testInfo.retry).toBe(1);
});
test('runner timeout tears down an unbounded native assertion', async ({ page }) => {
  test.setTimeout(150);
  await expect(page.locator('#never')).toHaveText('never', { timeout: 0 });
});
test('unimplemented browser matchers reject explicitly', async ({ page }) => {
  await assert.rejects(async () => { await expect(page.getByRole('status')).toHaveClass('ready'); }, error => error instanceof Error && error.name === 'UnsupportedFeatureError');
});
