const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Adding Todos", () => {
  test("should not add empty todo", async () => {
    await page.locator(".new-todo").click();
    await expectFocused(".new-todo");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".todo-list", { hidden: true, timeout });
  });
});
