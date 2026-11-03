import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Todo Creation", () => {
  test("Add multiple todos", async ({ page }) => {
    await expect(page.locator(".new-todo")).toBeVisible();
    await page.locator(".new-todo").fill("Buy groceries");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li label", { hasText: /^Buy groceries$/ })).toBeVisible();
    await page.locator(".new-todo").fill("Walk the dog");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li label", { hasText: /^Walk the dog$/ })).toBeVisible();
    await page.locator(".new-todo").fill("Read a book");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li label", { hasText: /^Read a book$/ })).toBeVisible();
    await expect(page.locator(".todo-list li label", { hasText: /^Buy groceries$/ })).toBeVisible();
    await expect(page.locator(".todo-list li label", { hasText: /^Walk the dog$/ })).toBeVisible();
    await expect(page.locator(".todo-list li label", { hasText: /^Read a book$/ })).toBeVisible();
    await expect(page.locator(".todo-count")).toHaveText("3 items left");
    await expect(page.locator(".todo-list li", { has: page.locator('label', { hasText: /^Buy groceries$/ }) }).locator('.toggle')).not.toBeChecked();
  });
});
