const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Completing Todos", () => {
  test("should toggle all todos incomplete", async () => {
    await page.locator(".new-todo").fill("First todo");
      await page.keyboard.press('Enter');
    await page.locator(".new-todo").fill("Second todo");
      await page.keyboard.press('Enter');
    await page.locator(".new-todo").fill("Third todo");
      await page.keyboard.press('Enter');
    await page.locator("label[for=\"toggle-all\"]").click();
    await expectText(".todo-count", "0 items left");
    await page.locator("label[for=\"toggle-all\"]").click();
    await expectText(".todo-count", "3 items left");
  });
});
