import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Editing Todos", () => {
  test("should delete todo when edited to empty", async ({ page }) => {
    await page.locator(".new-todo").fill("Temporary task");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li label", { hasText: /^Temporary task$/ })).toBeVisible();
    await expect(page.locator(".todo-count")).toHaveText("1 item left");
    await page.locator(".todo-list li label").dblclick();
    await expect(page.locator(".todo-list li .edit")).toBeVisible();
    await page.locator(".todo-list li .edit").fill("");
    await page.locator(".todo-list li .edit").press("Enter");
    await expect(page.locator(".todo-list li label", { hasText: /^Temporary task$/ })).not.toBeVisible();
    await expect(page.locator(".todo-list li label")).not.toBeVisible();
  });
});
