import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Editing Todos", () => {
  test("should trim whitespace when editing", async ({ page }) => {
    await page.locator(".new-todo").fill("Original task");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li label", { hasText: /^Original task$/ })).toBeVisible();
    await page.locator(".todo-list li label").dblclick();
    await page.locator(".todo-list li .edit").fill("   Edited task   ");
    await expect(page.locator(".todo-list li .edit")).toHaveValue("   Edited task   ");
    await page.locator(".todo-list li .edit").press("Enter");
    await expect(page.locator(".todo-list li label", { hasText: /^Edited task$/ })).toBeVisible();
  });
});
