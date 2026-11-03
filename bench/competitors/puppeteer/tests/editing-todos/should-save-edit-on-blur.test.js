const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require("../helpers");

beforeEach(async () => {
  await page.goto(process.env.APP_URL);
});

describe("Editing Todos", () => {
  test("should-save-edit-on-blur", async () => {
    await page.locator(".new-todo").fill("Call dentist");
      await page.keyboard.press('Enter');
    await page.locator(".todo-list li label").click({ count: 2 });
    await page.locator(".todo-list li .edit").fill("Schedule dentist appointment");
    await page.locator(".header h1").click();
    await page.waitForSelector(todoOf("Schedule dentist appointment"), { visible: true, timeout });
  });
});
