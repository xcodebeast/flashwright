const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Completing Todos", () => {
  test("should-uncomplete-completed-todo", async () => {
    await page.locator(".new-todo").fill("Buy groceries");
      await page.keyboard.press('Enter');
    await page.locator(".todo-list li .toggle").click();
    await page.locator(".todo-list li .toggle").click();
  });
});
