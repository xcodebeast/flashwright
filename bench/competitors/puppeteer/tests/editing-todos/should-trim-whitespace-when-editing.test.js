const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Editing Todos", () => {
  test("should trim whitespace when editing", async () => {
    await page.locator(".new-todo").fill("Original task");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Original task"), { visible: true, timeout });
    await page.locator(".todo-list li label").click({ count: 2 });
    await page.locator(".todo-list li .edit").fill("   Edited task   ");
    await expectValue(".todo-list li .edit", "   Edited task   ");
    await page.keyboard.press("Enter");
    await page.waitForSelector(todoOf("Edited task"), { visible: true, timeout });
  });
});
