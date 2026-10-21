import { test, expect } from '../adapter.mjs';

test.use({ storageState: { cookies: [], origins: [] } });

test('redirects to sign in when logged out', async ({ page }) => {
  await page.goto('/products');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('rejects a wrong password', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Password').fill('nope');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid credentials');
});

test('signs in', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('grace@example.com');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('grace@example.com')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
