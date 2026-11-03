import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Completing Todos", () => {
  test("should-toggle-all-todos-complete", async ({ page }) => {
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
    await page.locator("label[for=\"toggle-all\"]").click();
    await expect(page.locator(".todo-count")).toHaveText("0 items left");
    await expect(page.locator(".clear-completed")).toBeVisible();
  });
});
