const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Editing Todos", () => {
  test("should delete todo when edited to empty", async () => {
    await page.locator(".new-todo").fill("Temporary task");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Temporary task"), { visible: true, timeout });
    await expectText(".todo-count", "1 item left");
    await page.locator(".todo-list li label").click({ count: 2 });
    await page.waitForSelector(".todo-list li .edit", { visible: true, timeout });
    await page.locator(".todo-list li .edit").click({ count: 3 });
      await page.keyboard.press('Backspace');
    await page.keyboard.press("Enter");
    await page.waitForSelector(todoOf("Temporary task"), { hidden: true, timeout });
    await page.waitForSelector(".todo-list li label", { hidden: true, timeout });
  });
});
