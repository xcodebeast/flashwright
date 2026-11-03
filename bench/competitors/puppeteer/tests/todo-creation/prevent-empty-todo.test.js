const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Todo Creation", () => {
  test("Prevent adding empty todo", async () => {
    await page.waitForSelector(".new-todo", { visible: true, timeout });
    await page.locator(".new-todo").click();
    await page.keyboard.press("Enter");
    await expectCount(".todo-list li", 0);
    await expectValue(".new-todo", "");
  });
});
