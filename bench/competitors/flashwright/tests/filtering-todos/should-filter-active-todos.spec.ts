import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});

test.describe("Filtering Todos", () => {
  test("should-filter-active-todos", async ({ page }) => {
    await page.locator(".new-todo").fill("Active 1");
    await page.locator(".new-todo").press('Enter');
    await page.locator(".new-todo").fill("Active 2");
    await page.locator(".new-todo").press('Enter');
    await page.locator(".new-todo").fill("Will complete");
    await page.locator(".new-todo").press('Enter');
    await expect(page.locator(".todo-list li label", { hasText: /^Active 1$/ })).toBeVisible();
    await expect(page.locator(".todo-list li label", { hasText: /^Active 2$/ })).toBeVisible();
    await expect(page.locator(".todo-list li label", { hasText: /^Will complete$/ })).toBeVisible();
    await page.locator(".todo-list li", { has: page.locator('label', { hasText: /^Will complete$/ }) }).locator('.toggle').click();
    await expect(page.locator(".todo-list li", { has: page.locator('label', { hasText: /^Will complete$/ }) }).locator('.toggle')).toBeChecked();
    await expect(page.locator(".todo-count")).toHaveText("2 items left");
    await page.locator(".filters a[href=\"#/active\"]").click();
    await expect(page).toHaveURL(/\#\/active$/);
    await expect(page.locator(".todo-list li label", { hasText: /^Active 1$/ })).toBeVisible();
    await expect(page.locator(".todo-list li label", { hasText: /^Active 2$/ })).toBeVisible();
    await expect(page.locator(".todo-list li label", { hasText: /^Will complete$/ })).not.toBeVisible();
    await expect(page.locator(".filters a[href=\"#/active\"]")).toBeVisible();
  });
});
