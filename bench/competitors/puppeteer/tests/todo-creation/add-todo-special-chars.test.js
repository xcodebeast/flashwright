const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Todo Creation", () => {
  test("Add todo with special characters", async () => {
    await page.waitForSelector(".new-todo", { visible: true, timeout });
    await page.locator(".new-todo").fill("Buy @groceries & supplies (urgent!)");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Buy @groceries & supplies (urgent!)"), { visible: true, timeout });
    await expectText(".todo-count", "1 item left");
  });
});
