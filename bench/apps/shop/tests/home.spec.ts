import { test, expect } from '../adapter.mjs';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('shows store stats', async ({ page }) => {
  await expect(page.getByText('24 products in 3 categories')).toBeVisible();
  await expect(page.getByText('ada@example.com')).toBeVisible();
});

test('opens and closes the offer', async ({ page }) => {
  await page.getByRole('button', { name: 'Show offer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Offer' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});

test('claims the offer', async ({ page }) => {
  await page.getByRole('button', { name: 'Show offer' }).click();
  await page.getByRole('dialog', { name: 'Offer' }).getByRole('button', { name: 'Claim' }).click();
  await expect(page.getByRole('status')).toHaveText('Offer claimed');
});

test('navigates with the header', async ({ page }) => {
  await page.getByRole('link', { name: 'Products' }).click();
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  await page.getByRole('link', { name: /Cart/ }).click();
  await expect(page.getByRole('heading', { name: 'Cart' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/products$/);
});
