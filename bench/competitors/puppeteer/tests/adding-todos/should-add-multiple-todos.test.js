const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Adding Todos", () => {
  test("should add multiple todos", async () => {
    await page.locator(".new-todo").fill("Buy milk");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Buy milk"), { visible: true, timeout });
    await expectText(".todo-count", "1 item left");
    await page.locator(".new-todo").fill("Walk the dog");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Buy milk"), { visible: true, timeout });
    await page.waitForSelector(todoOf("Walk the dog"), { visible: true, timeout });
    await expectText(".todo-count", "2 items left");
    await page.locator(".new-todo").fill("Finish report");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Buy milk"), { visible: true, timeout });
    await page.waitForSelector(todoOf("Walk the dog"), { visible: true, timeout });
    await page.waitForSelector(todoOf("Finish report"), { visible: true, timeout });
    await expectText(".todo-count", "3 items left");
  });
});
