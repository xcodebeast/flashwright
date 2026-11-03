const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Deleting Todos", () => {
  test("should-delete-single-todo", async () => {
    await page.locator(".new-todo").fill("Task to delete");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Task to delete"), { visible: true, timeout });
    await expectText(".todo-count", "1 item left");
    await page.locator(itemOf(undefined)).hover();
    await page.waitForSelector(deleteOf(undefined), { visible: true, timeout });
    await page.locator(deleteOf(undefined)).click();
    await page.waitForSelector(todoOf("Task to delete"), { hidden: true, timeout });
    await page.waitForSelector(".todo-list li label", { hidden: true, timeout });
  });
});
