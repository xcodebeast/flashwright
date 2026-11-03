import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Adding Todos", () => {
  test("should not add empty todo", async ({ page }) => {
    await page.locator(".new-todo").click();
    await expect(page.locator(".new-todo")).toBeFocused();
    await page.locator(".new-todo").press("Enter");
    await expect(page.locator(".todo-list")).not.toBeVisible();
  });
});
