import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Completing Todos", () => {
  test("should-complete-single-todo", async ({ page }) => {
    await page.locator(".new-todo").fill("Buy groceries");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li label", { hasText: /^Buy groceries$/ })).toBeVisible();
    await expect(page.locator(".todo-count")).toHaveText("1 item left");
    await page.locator(".todo-list li .toggle").click();
    await expect(page.locator(".todo-list li .toggle")).toBeChecked();
    await expect(page.locator(".todo-count")).toHaveText("0 items left");
    await expect(page.locator(".clear-completed")).toBeVisible();
  });
});
