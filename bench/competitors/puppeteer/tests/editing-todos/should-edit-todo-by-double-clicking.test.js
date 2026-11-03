const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Editing Todos", () => {
  test("should edit todo by double-clicking", async () => {
    await page.locator(".new-todo").fill("Buy milk");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Buy milk"), { visible: true, timeout });
    await page.locator(".todo-list li label").click({ count: 2 });
    await page.waitForSelector(".todo-list li .edit", { visible: true, timeout });
    await expectValue(".todo-list li .edit", "Buy milk");
    await page.locator(".todo-list li .edit").fill("Buy organic milk");
    await page.keyboard.press("Enter");
    await page.waitForSelector(todoOf("Buy organic milk"), { visible: true, timeout });
  });
});
