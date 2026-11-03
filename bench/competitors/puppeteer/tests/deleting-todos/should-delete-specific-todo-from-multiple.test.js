const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Deleting Todos", () => {
  test("should-delete-specific-todo-from-multiple", async () => {
    await page.locator(".new-todo").fill("Task 1");
      await page.keyboard.press('Enter');
    await page.locator(".new-todo").fill("Task 2");
      await page.keyboard.press('Enter');
    await page.locator(".new-todo").fill("Task 3");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Task 1"), { visible: true, timeout });
    await page.waitForSelector(todoOf("Task 2"), { visible: true, timeout });
    await page.waitForSelector(todoOf("Task 3"), { visible: true, timeout });
    await expectText(".todo-count", "3 items left");
    await page.locator(itemOf("Task 2")).hover();
    await page.locator(deleteOf("Task 2")).click();
    await page.waitForSelector(todoOf("Task 1"), { visible: true, timeout });
    await page.waitForSelector(todoOf("Task 3"), { visible: true, timeout });
    await expectText(".todo-count", "2 items left");
  });
});
