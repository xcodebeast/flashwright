const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Filtering Todos", () => {
  test("should-filter-active-todos", async () => {
    await page.locator(".new-todo").fill("Active 1");
      await page.keyboard.press('Enter');
    await page.locator(".new-todo").fill("Active 2");
      await page.keyboard.press('Enter');
    await page.locator(".new-todo").fill("Will complete");
      await page.keyboard.press('Enter');
    await page.waitForSelector(todoOf("Active 1"), { visible: true, timeout });
    await page.waitForSelector(todoOf("Active 2"), { visible: true, timeout });
    await page.waitForSelector(todoOf("Will complete"), { visible: true, timeout });
    await page.locator(toggleOf("Will complete")).click();
    await expectChecked("Will complete", true);
    await expectText(".todo-count", "2 items left");
    await page.locator(".filters a[href=\"#/active\"]").click();
    await expectUrlEnding("#/active");
    await page.waitForSelector(todoOf("Active 1"), { visible: true, timeout });
    await page.waitForSelector(todoOf("Active 2"), { visible: true, timeout });
    await page.waitForSelector(todoOf("Will complete"), { hidden: true, timeout });
    await page.waitForSelector(".filters a[href=\"#/active\"]", { visible: true, timeout });
  });
});
