/* eslint-disable notice/notice */

import { test, expect } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('https://demo.playwright.dev/todomvc');
});

test('adds todo items', async ({ page }) => {
  const newTodo = page.getByRole('textbox', { name: 'What needs to be done?' });
  await newTodo.fill('Buy milk');
  await newTodo.press('Enter');
  await newTodo.fill('Walk the dog');
  await newTodo.press('Enter');

  await expect(page.getByRole('listitem').filter({ hasText: 'Buy milk' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Walk the dog' })).toBeVisible();
  await expect(page.getByText('2 items left')).toBeVisible();
});

test('completes a todo item', async ({ page }) => {
  const newTodo = page.getByRole('textbox', { name: 'What needs to be done?' });
  await newTodo.fill('Buy milk');
  await newTodo.press('Enter');

  const toggle = page.getByRole('listitem').filter({ hasText: 'Buy milk' }).getByRole('checkbox');
  await toggle.check();

  await expect(toggle).toBeChecked();
  await expect(page.getByText('0 items left')).toBeVisible();
});

test('starts every test with an empty list', async ({ page }) => {
  await expect(page.getByRole('textbox', { name: 'What needs to be done?' })).toBeVisible();
  await expect(page.getByText('items left')).toHaveCount(0);
});
