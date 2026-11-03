import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Deleting Todos", () => {
  test("should-delete-single-todo", async ({ page }) => {
    await page.locator(".new-todo").fill("Task to delete");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li label", { hasText: /^Task to delete$/ })).toBeVisible();
    await expect(page.locator(".todo-count")).toHaveText("1 item left");
    await page.locator(".todo-list li").hover();
    await expect(page.locator(".todo-list li").locator('.destroy')).toBeVisible();
    await page.locator(".todo-list li").locator('.destroy').click();
    await expect(page.locator(".todo-list li label", { hasText: /^Task to delete$/ })).not.toBeVisible();
    await expect(page.locator(".todo-list li label")).not.toBeVisible();
  });
});
