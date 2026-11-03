const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Adding Todos", () => {
  test("should trim whitespace from new todo", async () => {
    await page.locator(".new-todo").fill("   Todo with spaces   ");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Todo with spaces"), { visible: true, timeout });
    await expectText(".todo-count", "1 item left");
  });
});
