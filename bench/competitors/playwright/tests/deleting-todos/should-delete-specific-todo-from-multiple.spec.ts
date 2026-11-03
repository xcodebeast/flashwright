import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Deleting Todos", () => {
  test("should-delete-specific-todo-from-multiple", async ({ page }) => {
    await page.locator(".new-todo").fill("Task 1");
    await page.locator(".new-todo").press('Enter');
    await page.locator(".new-todo").fill("Task 2");
    await page.locator(".new-todo").press('Enter');
    await page.locator(".new-todo").fill("Task 3");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li label", { hasText: /^Task 1$/ })).toBeVisible();
    await expect(page.locator(".todo-list li label", { hasText: /^Task 2$/ })).toBeVisible();
    await expect(page.locator(".todo-list li label", { hasText: /^Task 3$/ })).toBeVisible();
    await expect(page.locator(".todo-count")).toHaveText("3 items left");
    await page.locator(".todo-list li", { has: page.locator('label', { hasText: /^Task 2$/ }) }).hover();
    await page.locator(".todo-list li", { has: page.locator('label', { hasText: /^Task 2$/ }) }).locator('.destroy').click();
    await expect(page.locator(".todo-list li label", { hasText: /^Task 1$/ })).toBeVisible();
    await expect(page.locator(".todo-list li label", { hasText: /^Task 3$/ })).toBeVisible();
    await expect(page.locator(".todo-count")).toHaveText("2 items left");
  });
});
