const assert = require('node:assert/strict');
const { test, expect } = require(process.env.FLASHWRIGHT_ARIA_ENGINE === 'playwright' ? '@playwright/test' : '@flashwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.FLASHWRIGHT_ARIA_URL);
});

test('page assertion preserves indented role tree and states', async ({ page }) => {
  await expect(page).toMatchAriaSnapshot(`
    - heading "Snapshot fixture" [level=1]
    - main:
      - button "Save"
      - checkbox "Choice" [checked]
      - textbox "Name": Ada
      - status: Ready
    - list:
      - listitem: First
      - listitem: Second
  `);
});

test('locator assertion scopes the tree and matches name expressions', async ({ page }) => {
  await expect(page.getByRole('main')).toMatchAriaSnapshot(`
    - main:
      - button /Sa.e/
      - checkbox "Choice" [checked]
      - textbox "Name": Ada
      - status: Ready
  `);
  await expect(page.getByRole('button', { name: 'Save' })).not.toMatchAriaSnapshot('- button "Delete"');
});

test('children containment and equality keep their full predicates', async ({ page }) => {
  const list = page.getByRole('list');
  await expect(list).toMatchAriaSnapshot('- list:\n  - listitem: First');
  await assert.rejects(() => expect(list).toMatchAriaSnapshot('- /children: deep-equal\n- list:\n  - listitem: First', { timeout: 100 }));
  await expect(list).toMatchAriaSnapshot('- /children: deep-equal\n- list:\n  - listitem: First\n  - listitem: Second');
});

test('resident retry sees accessibility mutations under the original deadline', async ({ page }) => {
  await page.evaluate(() => { setTimeout(() => { document.querySelector('[role=status]').textContent = 'Saved'; }, 60); });
  await expect(page.getByRole('status')).toMatchAriaSnapshot('- status: Saved');
});

test('negated retry waits for the observed tree to change', async ({ page }) => {
  await page.evaluate(() => { setTimeout(() => { document.querySelector('[role=status]').textContent = 'Saved'; }, 60); });
  await expect(page.getByRole('status')).not.toMatchAriaSnapshot('- status: Ready');
});

test('same-process frame locator keeps the child document', async ({ page }) => {
  await expect(page.frameLocator('iframe').getByRole('button')).toMatchAriaSnapshot('- button "Inside"');
});

test('shadow content participates while hidden content is omitted', async ({ page }) => {
  await page.evaluate(() => {
    const host = document.createElement('section');
    host.id = 'shadow';
    host.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow</button><button hidden>Hidden</button>';
    document.body.append(host);
  });
  await expect(page.locator('#shadow')).toMatchAriaSnapshot('- button "Shadow"');
});

test('missing targets and strict selector errors remain failures', async ({ page }) => {
  await assert.rejects(() => expect(page.locator('#missing')).toMatchAriaSnapshot('- button "Save"', { timeout: 100 }));
  await assert.rejects(() => expect(page.getByRole('listitem')).toMatchAriaSnapshot('- listitem: First'), /strict mode violation/);
});

test('invalid templates reject before waiting on a missing target', async ({ page }) => {
  await assert.rejects(() => expect(page.locator('#missing')).toMatchAriaSnapshot('- button "unterminated', { timeout: 1000 }));
});

test('soft snapshot mismatch reaches the runner and execution continues', async ({ page }, testInfo) => {
  test.fail();
  await expect.soft(page.getByRole('status')).toMatchAriaSnapshot('- status: Wrong', { timeout: 100 });
  expect(testInfo.errors).toHaveLength(1);
  await expect(page.getByRole('status')).toMatchAriaSnapshot('- status: Ready');
});

test('configured assertion timeout reports the retained tree and call site', async ({ page }) => {
  await assert.rejects(() => expect.configure({ timeout: 100 })(page.getByRole('status')).toMatchAriaSnapshot('- status: Wrong'), error => {
    assert.match(error.message, /Ready/);
    assert.match(error.message, /Wrong/);
    assert.match(error.stack, /assertions.spec.cjs/);
    assert.equal(error.matcherResult.timeout, 100);
    return true;
  });
});
