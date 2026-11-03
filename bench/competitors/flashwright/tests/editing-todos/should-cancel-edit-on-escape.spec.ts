import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Editing Todos", () => {
  test("should-cancel-edit-on-escape", async ({ page }) => {
    await page.locator(".new-todo").fill("Original text");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li label", { hasText: /^Original text$/ })).toBeVisible();
    await page.locator(".todo-list li label").dblclick();
    await expect(page.locator(".todo-list li .edit")).toHaveValue("Original text");
    await page.locator(".todo-list li .edit").fill("Modified text");
    await page.locator(".todo-list li .edit").press("Escape");
    await expect(page.locator(".todo-list li label", { hasText: /^Original text$/ })).toBeVisible();
  });
});
