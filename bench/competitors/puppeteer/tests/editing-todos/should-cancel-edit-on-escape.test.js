const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Editing Todos", () => {
  test("should-cancel-edit-on-escape", async () => {
    await page.locator(".new-todo").fill("Original text");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Original text"), { visible: true, timeout });
    await page.locator(".todo-list li label").click({ count: 2 });
    await expectValue(".todo-list li .edit", "Original text");
    await page.locator(".todo-list li .edit").fill("Modified text");
    await page.keyboard.press("Escape");
    await page.waitForSelector(todoOf("Original text"), { visible: true, timeout });
  });
});
