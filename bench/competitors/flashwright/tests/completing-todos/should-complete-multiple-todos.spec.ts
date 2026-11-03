import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Completing Todos", () => {
  test("should complete multiple todos", async ({ page }) => {
    await page.locator(".new-todo").fill("Buy milk");
    await page.locator(".new-todo").press('Enter');
    await page.locator(".new-todo").fill("Walk dog");
    await page.locator(".new-todo").press('Enter');
    await page.locator(".new-todo").fill("Finish report");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li label", { hasText: /^Buy milk$/ })).toBeVisible();
    await expect(page.locator(".todo-list li label", { hasText: /^Walk dog$/ })).toBeVisible();
    await expect(page.locator(".todo-list li label", { hasText: /^Finish report$/ })).toBeVisible();
    await expect(page.locator(".todo-count")).toHaveText("3 items left");
    await page.locator(".todo-list li", { has: page.locator('label', { hasText: /^Buy milk$/ }) }).locator('.toggle').click();
    await expect(page.locator(".todo-list li", { has: page.locator('label', { hasText: /^Buy milk$/ }) }).locator('.toggle')).toBeChecked();
    await expect(page.locator(".todo-count")).toHaveText("2 items left");
    await page.locator(".todo-list li", { has: page.locator('label', { hasText: /^Finish report$/ }) }).locator('.toggle').click();
    await expect(page.locator(".todo-list li", { has: page.locator('label', { hasText: /^Finish report$/ }) }).locator('.toggle')).toBeChecked();
    await expect(page.locator(".todo-count")).toHaveText("1 item left");
    await expect(page.locator(".clear-completed")).toBeVisible();
  });
});
