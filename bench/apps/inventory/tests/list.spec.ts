import { test, expect } from '../adapter.mjs';
import { items } from './data.mjs';

test.beforeEach(async ({ page }) => {
  await page.goto('/inventory');
  await expect(page.getByRole('row')).toHaveCount(items.length + 1);
});

test('lists every item', async ({ page }) => {
  await expect(page.getByText(`Showing ${items.length} items`)).toBeVisible();
  await expect(page.getByRole('row', { name: /SKU-0001/ })).toContainText('Item 1');
  await expect(page.getByRole('row').last()).toContainText('SKU-0400');
});

test('searches by SKU', async ({ page }) => {
  await page.getByRole('searchbox', { name: 'Search items' }).fill('SKU-0123');
  await expect(page.getByRole('row')).toHaveCount(2);
  await expect(page.getByRole('row', { name: /SKU-0123/ })).toContainText('Item 123');
});

test('searches by name', async ({ page }) => {
  await page.getByRole('searchbox', { name: 'Search items' }).fill('Item 12');
  const expected = items.filter(item => item.name.toLowerCase().includes('item 12')).length;
  await expect(page.getByRole('row')).toHaveCount(expected + 1);
});

test('shows when nothing matches', async ({ page }) => {
  await page.getByRole('searchbox', { name: 'Search items' }).fill('nothing like this');
  await expect(page.getByText('No items match')).toBeVisible();
});

test('clears the search with Escape', async ({ page }) => {
  const search = page.getByRole('searchbox', { name: 'Search items' });
  await search.fill('SKU-0007');
  await expect(page.getByRole('row')).toHaveCount(2);
  await search.press('Escape');
  await expect(page.getByRole('row')).toHaveCount(items.length + 1);
});

test('filters by category', async ({ page }) => {
  await page.getByRole('checkbox', { name: 'Books' }).check();
  await expect(page.getByRole('row')).toHaveCount(items.filter(item => item.category === 'Books').length + 1);
  await page.getByRole('checkbox', { name: 'Games' }).check();
  await expect(page.getByRole('row')).toHaveCount(items.filter(item => ['Books', 'Games'].includes(item.category)).length + 1);
});

test('filters by status', async ({ page }) => {
  await page.getByRole('radio', { name: 'Low stock' }).check();
  const low = items.filter(item => item.status === 'Low stock').length;
  await expect(page.getByRole('row')).toHaveCount(low + 1);
  await expect(page.getByRole('cell', { name: 'Low stock' })).toHaveCount(low);
});

test('filters by warehouse and price', async ({ page }) => {
  await page.getByLabel('Warehouse').selectOption('North');
  await page.getByLabel('Max price').fill('50');
  await expect(page.getByRole('row')).toHaveCount(items.filter(item => item.warehouse === 'North' && item.price <= 50).length + 1);
});

test('resets the filters', async ({ page }) => {
  await page.getByRole('checkbox', { name: 'Tools' }).check();
  await page.getByRole('radio', { name: 'In stock' }).check();
  await expect(page.getByRole('row')).toHaveCount(items.filter(item => item.category === 'Tools' && item.status === 'In stock').length + 1);
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(page.getByRole('row')).toHaveCount(items.length + 1);
});

test('sorts by price', async ({ page }) => {
  const cheapest = [...items].sort((a, b) => a.price - b.price)[0];
  const priciest = [...items].sort((a, b) => b.price - a.price)[0];
  await page.getByRole('button', { name: 'Price' }).click();
  await expect(page.getByRole('columnheader', { name: 'Price' })).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.getByRole('row').nth(1)).toContainText(cheapest.sku);
  await page.getByRole('button', { name: 'Price' }).click();
  await expect(page.getByRole('row').nth(1)).toContainText(priciest.sku);
});
