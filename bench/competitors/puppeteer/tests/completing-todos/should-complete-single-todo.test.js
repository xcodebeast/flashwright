const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Completing Todos", () => {
  test("should-complete-single-todo", async () => {
    await page.locator(".new-todo").fill("Buy groceries");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Buy groceries"), { visible: true, timeout });
    await expectText(".todo-count", "1 item left");
    await page.locator(".todo-list li .toggle").click();
    await expectChecked(undefined, true);
    await expectText(".todo-count", "0 items left");
    await page.waitForSelector(".clear-completed", { visible: true, timeout });
  });
});
