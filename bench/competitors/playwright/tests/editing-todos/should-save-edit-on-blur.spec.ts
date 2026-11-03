import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Editing Todos", () => {
  test("should-save-edit-on-blur", async ({ page }) => {
    await page.locator(".new-todo").fill("Call dentist");
    await page.locator(".new-todo").press('Enter');
    await page.locator(".todo-list li label").dblclick();
    await page.locator(".todo-list li .edit").fill("Schedule dentist appointment");
    await page.locator(".header h1").click();
    await expect(page.locator(".todo-list li label", { hasText: /^Schedule dentist appointment$/ })).toBeVisible();
  });
});
