import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Todo Creation", () => {
  test("Prevent adding whitespace-only todo", async ({ page }) => {
    await expect(page.locator(".new-todo")).toBeVisible();
    await page.locator(".new-todo").fill("   ");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li")).toHaveCount(0);
  });
});
