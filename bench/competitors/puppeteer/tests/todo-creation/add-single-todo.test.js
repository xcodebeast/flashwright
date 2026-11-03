const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Todo Creation", () => {
  test("Add a single todo", async () => {
    await page.waitForSelector(".new-todo", { visible: true, timeout });
    await page.locator(".new-todo").fill("Buy groceries");
    await expectValue(".new-todo", "Buy groceries");
    await page.keyboard.press("Enter");
    await page.waitForSelector(todoOf("Buy groceries"), { visible: true, timeout });
    await expectValue(".new-todo", "");
    await expectText(".todo-count", "1 item left");
    await expectChecked(undefined, false);
  });
});
