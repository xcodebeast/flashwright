import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Completing Todos", () => {
  test("should-uncomplete-completed-todo", async ({ page }) => {
    await page.locator(".new-todo").fill("Buy groceries");
    await page.locator(".new-todo").press('Enter');
    await page.locator(".todo-list li .toggle").click();
    await page.locator(".todo-list li .toggle").click();
  });
});
