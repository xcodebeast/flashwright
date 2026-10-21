import { test, expect } from '../adapter.mjs';

test.beforeEach(async ({ page }) => {
  await page.goto('/products');
  await expect(page.getByTestId('product')).toHaveCount(24);
});

test('lists every product', async ({ page }) => {
  await expect(page.getByTestId('product').first()).toContainText('Product 1');
  await expect(page.getByTestId('product').last()).toContainText('Product 24');
});

test('searches by name', async ({ page }) => {
  await page.getByLabel('Search').fill('Product 2');
  await expect(page.getByTestId('product')).toHaveCount(6);
});

test('shows an empty state', async ({ page }) => {
  await page.getByLabel('Search').fill('nothing like this');
  await expect(page.getByText('No products found')).toBeVisible();
});

test('filters by category', async ({ page }) => {
  await page.getByLabel('Category').selectOption('Games');
  await expect(page.getByTestId('product')).toHaveCount(8);
  for (const card of await page.getByTestId('product').all())
    await expect(card).toContainText('Games');
});

test('adds to cart', async ({ page }) => {
  await page.getByTestId('product').filter({ hasText: 'Product 3' }).first().getByRole('button').click();
  await expect(page.getByRole('status')).toHaveText('Added to cart');
  await expect(page.getByRole('link', { name: 'Cart (1)' })).toBeVisible();
});
