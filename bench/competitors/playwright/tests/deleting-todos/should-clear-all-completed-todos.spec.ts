import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Deleting Todos", () => {
  test("should-clear-all-completed-todos", async ({ page }) => {
    await page.locator(".new-todo").fill("Task 1");
    await page.locator(".new-todo").press('Enter');
    await page.locator(".new-todo").fill("Task 2");
    await page.locator(".new-todo").press('Enter');
    await page.locator(".new-todo").fill("Task 3");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li label")).toHaveText(["Task 1","Task 2","Task 3"]);
    await page.locator(".todo-list li", { has: page.locator('label', { hasText: /^Task 1$/ }) }).locator('.toggle').click();
    await page.locator(".todo-list li", { has: page.locator('label', { hasText: /^Task 3$/ }) }).locator('.toggle').click();
    await expect(page.locator(".todo-count")).toHaveText("1 item left");
    await expect(page.locator(".clear-completed")).toBeVisible();
    await page.locator(".clear-completed").click();
    await expect(page.locator(".todo-list li label", { hasText: /^Task 2$/ })).toBeVisible();
    await expect(page.locator(".todo-count")).toHaveText("1 item left");
  });
});
