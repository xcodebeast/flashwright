import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Todo Creation", () => {
  test("Prevent adding empty todo", async ({ page }) => {
    await expect(page.locator(".new-todo")).toBeVisible();
    await page.locator(".new-todo").click();
    await page.locator(".new-todo").press("Enter");
    await expect(page.locator(".todo-list li")).toHaveCount(0);
    await expect(page.locator(".new-todo")).toHaveValue("");
  });
});
