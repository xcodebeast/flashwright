import { test, expect } from '../adapter.mjs';

async function addProducts(page, names: string[]) {
  await page.goto('/products');
  for (const name of names) {
    await page.getByTestId('product').filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByRole('status').last()).toHaveText('Added to cart');
  }
}

test('starts empty', async ({ page }) => {
  await page.goto('/cart');
  await expect(page.getByText('Total: $0')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Checkout' })).toBeDisabled();
});

test('sums the total', async ({ page }) => {
  await addProducts(page, ['Product 1', 'Product 2']);
  await page.getByRole('link', { name: /Cart/ }).click();
  await expect(page.getByRole('listitem')).toHaveCount(2);
  await expect(page.locator('#total')).toHaveText('Total: $17');
});

test('removes an item', async ({ page }) => {
  await addProducts(page, ['Product 4', 'Product 5']);
  await page.getByRole('link', { name: /Cart/ }).click();
  await page.getByRole('listitem').filter({ hasText: 'Product 4' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Cart (1)' })).toBeVisible();
});

test('checks out', async ({ page }) => {
  await addProducts(page, ['Product 6']);
  await page.getByRole('link', { name: /Cart/ }).click();
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible();
  await expect(page.getByText(/Order #\d+ confirmed/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Cart (0)' })).toBeVisible();
});

test('keeps the cart across reloads', async ({ page }) => {
  await addProducts(page, ['Product 7']);
  await page.reload();
  await expect(page.getByRole('link', { name: 'Cart (1)' })).toBeVisible();
});
