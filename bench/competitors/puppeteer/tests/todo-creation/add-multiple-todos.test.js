const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Todo Creation", () => {
  test("Add multiple todos", async () => {
    await page.waitForSelector(".new-todo", { visible: true, timeout });
    await page.locator(".new-todo").fill("Buy groceries");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Buy groceries"), { visible: true, timeout });
    await page.locator(".new-todo").fill("Walk the dog");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Walk the dog"), { visible: true, timeout });
    await page.locator(".new-todo").fill("Read a book");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Read a book"), { visible: true, timeout });
    await page.waitForSelector(todoOf("Buy groceries"), { visible: true, timeout });
    await page.waitForSelector(todoOf("Walk the dog"), { visible: true, timeout });
    await page.waitForSelector(todoOf("Read a book"), { visible: true, timeout });
    await expectText(".todo-count", "3 items left");
    await expectChecked("Buy groceries", false);
  });
});
