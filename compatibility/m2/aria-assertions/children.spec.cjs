const assert = require('node:assert/strict');
const { test, expect } = require(process.env.FLASHWRIGHT_ARIA_ENGINE === 'playwright' ? '@playwright/test' : '@flashwright/test');

test('configured children policy and explicit template override', async ({ page }) => {
  await page.goto(process.env.FLASHWRIGHT_ARIA_URL);
  const list = page.getByRole('list');
  await assert.rejects(() => expect(list).toMatchAriaSnapshot('- list:\n  - listitem: First'));
  await expect(list).toMatchAriaSnapshot('- /children: contain\n- list:\n  - listitem: First');
});
