import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Adding Todos", () => {
  test("should trim whitespace from new todo", async ({ page }) => {
    await page.locator(".new-todo").fill("   Todo with spaces   ");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li label", { hasText: /^Todo with spaces$/ })).toBeVisible();
    await expect(page.locator(".todo-count")).toHaveText("1 item left");
  });
});
