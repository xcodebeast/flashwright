import { test, expect } from '../adapter.mjs';
import { items } from './data.mjs';

test.beforeEach(async ({ page }) => {
  await page.goto('/inventory');
  await expect(page.getByRole('row')).toHaveCount(items.length + 1);
});

test('edits an item', async ({ page }) => {
  const row = page.getByRole('row', { name: /SKU-0042/ });
  await row.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit SKU-0042' });
  await dialog.getByLabel('Stock').fill('7');
  await dialog.getByLabel('Price').fill('12.5');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved SKU-0042');
  await expect(row.getByRole('cell', { name: 'Low stock' })).toBeVisible();
  await expect(row).toContainText('$12.50');
});

test('cancels an edit', async ({ page }) => {
  const row = page.getByRole('row', { name: /SKU-0050/ });
  await row.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit SKU-0050' });
  await dialog.getByLabel('Name').fill('Renamed');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText('Item 50');
});

test('deletes an item', async ({ page }) => {
  await page.getByRole('row', { name: /SKU-0099/ }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete SKU-0099?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('status')).toHaveText('Deleted SKU-0099');
  await expect(page.getByRole('row', { name: /SKU-0099/ })).toHaveCount(0);
  await expect(page.getByRole('row')).toHaveCount(items.length);
});

test('deletes the selected items', async ({ page }) => {
  for (const sku of ['SKU-0003', 'SKU-0004', 'SKU-0005'])
    await page.getByRole('checkbox', { name: `Select ${sku}` }).check();
  await page.getByRole('button', { name: 'Delete selected (3)' }).click();
  await page.getByRole('dialog', { name: 'Delete 3 items?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('status')).toHaveText('Deleted 3 items');
  await expect(page.getByRole('row')).toHaveCount(items.length - 2);
});

test('selects every item', async ({ page }) => {
  await page.getByRole('checkbox', { name: 'Select all' }).check();
  await expect(page.getByRole('button', { name: `Delete selected (${items.length})` })).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: 'Select SKU-0400' })).toBeChecked();
});

test('duplicates an item from its menu', async ({ page }) => {
  await page.getByRole('row', { name: /SKU-0010/ }).getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(page.getByRole('status')).toHaveText('Duplicated SKU-0010');
  await expect(page.getByRole('row', { name: /SKU-0010-COPY/ })).toContainText('Item 10 copy');
});

test('exports the visible items', async ({ page }) => {
  await page.getByRole('checkbox', { name: 'Kitchen' }).check();
  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByRole('status')).toHaveText(`Exported ${items.filter(item => item.category === 'Kitchen').length} items`);
});
