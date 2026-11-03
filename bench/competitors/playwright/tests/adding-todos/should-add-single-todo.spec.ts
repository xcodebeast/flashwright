import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Adding Todos", () => {
  test("should add single todo", async ({ page }) => {
    await expect(page.locator(".new-todo")).toBeVisible();
    await page.locator(".new-todo").fill("Buy groceries");
    await expect(page.locator(".new-todo")).toHaveValue("Buy groceries");
    await page.locator(".new-todo").press("Enter");
    await expect(page.locator(".todo-list li label", { hasText: /^Buy groceries$/ })).toBeVisible();
    await expect(page.locator(".new-todo")).toHaveValue("");
    await expect(page.locator(".todo-count")).toHaveText("1 item left");
  });
});
