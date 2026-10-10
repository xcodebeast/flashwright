const { test, expect } = require(process.env.FLASHWRIGHT_ARIA_ENGINE === 'playwright' ? '@playwright/test' : '@flashwright/test');

test('snapshot baseline policy', async ({ page }) => {
  await page.goto(process.env.FLASHWRIGHT_ARIA_URL);
  if (process.env.FLASHWRIGHT_ARIA_TEXT_LENGTH) await page.evaluate(length => { document.querySelector('[role=status]').textContent = 'a'.repeat(length); }, Number(process.env.FLASHWRIGHT_ARIA_TEXT_LENGTH));
  const target = process.env.FLASHWRIGHT_ARIA_MISSING_TARGET === '1' ? page.locator('#missing') : page.getByRole('status');
  const assertion = process.env.FLASHWRIGHT_ARIA_NEGATED === '1' ? expect(target).not : expect(target);
  if (process.env.FLASHWRIGHT_ARIA_INLINE === '1') {
    await expect(page.getByRole('status')).toMatchAriaSnapshot('');
  }
  else await assertion.toMatchAriaSnapshot({ name: 'status.aria.yml' });
});
