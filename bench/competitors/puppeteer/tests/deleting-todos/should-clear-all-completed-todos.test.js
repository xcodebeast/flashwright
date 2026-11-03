const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Deleting Todos", () => {
  test("should-clear-all-completed-todos", async () => {
    await page.locator(".new-todo").fill("Task 1");
      await page.keyboard.press('Enter');
    await page.locator(".new-todo").fill("Task 2");
      await page.keyboard.press('Enter');
    await page.locator(".new-todo").fill("Task 3");
      await page.keyboard.press('Enter');
    await expectTexts(".todo-list li label", ["Task 1","Task 2","Task 3"]);
    await page.locator(toggleOf("Task 1")).click();
    await page.locator(toggleOf("Task 3")).click();
    await expectText(".todo-count", "1 item left");
    await page.waitForSelector(".clear-completed", { visible: true, timeout });
    await page.locator(".clear-completed").click();
    await page.waitForSelector(todoOf("Task 2"), { visible: true, timeout });
    await expectText(".todo-count", "1 item left");
  });
});
