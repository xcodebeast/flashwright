import { test, expect } from '../adapter.mjs';
import { items } from './data.mjs';

test('opens the reports', async ({ page }) => {
  await page.goto('/inventory');
  await expect(page.getByRole('row')).toHaveCount(items.length + 1);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Item 77 sales' })).toBeVisible();
  await expect(page.getByRole('listitem')).toHaveCount(200);
});

test('comes back to the inventory', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('link', { name: 'Inventory' }).click();
  await expect(page.getByRole('row')).toHaveCount(items.length + 1);
  await page.goBack();
  await expect(page.getByText('Nothing here yet.')).toBeVisible();
});
