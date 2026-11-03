import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Editing Todos", () => {
  test("should edit todo by double-clicking", async ({ page }) => {
    await page.locator(".new-todo").fill("Buy milk");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li label", { hasText: /^Buy milk$/ })).toBeVisible();
    await page.locator(".todo-list li label").dblclick();
    await expect(page.locator(".todo-list li .edit")).toBeVisible();
    await expect(page.locator(".todo-list li .edit")).toHaveValue("Buy milk");
    await page.locator(".todo-list li .edit").fill("Buy organic milk");
    await page.locator(".todo-list li .edit").press("Enter");
    await expect(page.locator(".todo-list li label", { hasText: /^Buy organic milk$/ })).toBeVisible();
  });
});
