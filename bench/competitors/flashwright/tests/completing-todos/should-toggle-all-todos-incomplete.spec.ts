import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Completing Todos", () => {
  test("should toggle all todos incomplete", async ({ page }) => {
    await page.locator(".new-todo").fill("First todo");
    await page.locator(".new-todo").press('Enter');
    await page.locator(".new-todo").fill("Second todo");
    await page.locator(".new-todo").press('Enter');
    await page.locator(".new-todo").fill("Third todo");
    await page.locator(".new-todo").press('Enter');
    await page.locator("label[for=\"toggle-all\"]").click();
    await expect(page.locator(".todo-count")).toHaveText("0 items left");
    await page.locator("label[for=\"toggle-all\"]").click();
    await expect(page.locator(".todo-count")).toHaveText("3 items left");
  });
});
