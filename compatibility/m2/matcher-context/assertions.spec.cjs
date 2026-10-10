const { test, expect } = require(process.env.FLASHWRIGHT_MATCHER_CONTEXT_ENGINE === 'playwright' ? '@playwright/test' : '@flashwright/test');

test.beforeEach(async ({ page }) => { await page.goto(process.env.FLASHWRIGHT_MATCHER_CONTEXT_URL); });
test.afterEach(async ({}, testInfo) => {
  await testInfo.attach('matcher-context-observation', {
    body: JSON.stringify(testInfo.errors.map(error => error.errorContext ?? null)),
    contentType: 'application/json',
  });
});

const assertions = {
  'visible text retains target tree': page => expect(page.locator('#target')).toHaveText('Different'),
  'negated text retains target tree': page => expect(page.locator('#target')).not.toHaveText('Original'),
  'hidden target retains body tree': page => expect(page.locator('#hidden')).toBeVisible(),
  'missing target retains body tree': page => expect(page.locator('#missing')).toBeVisible(),
  'page title retains body tree': page => expect(page).toHaveTitle('Different'),
  'count omits matcher tree': page => expect(page.locator('button')).toHaveCount(99),
  'array omits matcher tree': page => expect(page.locator('#target')).toHaveText(['Different']),
  'ARIA matcher omits matcher tree': page => expect(page.locator('#target')).toMatchAriaSnapshot('- button "Different"'),
  'frame locator retains child tree': page => expect(page.frameLocator('iframe').locator('button')).toHaveText('Different'),
};
for (const [title, assertion] of Object.entries(assertions)) {
  test(title, async ({ page }) => { test.fail(); await assertion(page); });
}

test('soft failure keeps original tree after later mutation', async ({ page }) => {
  test.fail();
  await expect.soft(page.locator('#target')).toHaveText('Different');
  await page.evaluate(() => { document.querySelector('#target').textContent = 'Successor'; });
});

test('passing matcher produces no error context', async ({ page }) => {
  await expect(page.locator('#target')).toHaveText('Original');
});

test('oversized tree remains an explicitly bounded diagnostic', async ({ page }) => {
  test.fail();
  await page.evaluate(() => {
    const container = document.createElement('div');
    container.id = 'large-tree';
    for (let index = 0; index < 1500; index++) {
      const button = document.createElement('button');
      button.textContent = `Diagnostic item ${index}`;
      container.appendChild(button);
    }
    document.body.appendChild(container);
  });
  await expect(page.locator('#large-tree')).toHaveText('Different');
});
