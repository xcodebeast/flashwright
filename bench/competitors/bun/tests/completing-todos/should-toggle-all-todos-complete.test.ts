import { afterEach, beforeEach, describe, test } from 'bun:test';
import { openApp, closeApp, fill, hover, itemOf, expectText, expectTodo, expectVisible, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } from "../helpers";

let view: Bun.WebView;

beforeEach(async () => {
  view = await openApp();
});

afterEach(() => {
  closeApp(view);
});

describe("Completing Todos", () => {
  test("should-toggle-all-todos-complete", async () => {
    await fill(view, ".new-todo", "Task 1");
      await view.press('Enter');
    await fill(view, ".new-todo", "Task 2");
      await view.press('Enter');
    await fill(view, ".new-todo", "Task 3");
      await view.press('Enter');
    await expectTodo(view, "Task 1", true);
    await expectTodo(view, "Task 2", true);
    await expectTodo(view, "Task 3", true);
    await expectText(view, ".todo-count", "3 items left");
    await view.click("label[for=\"toggle-all\"]");
    await expectText(view, ".todo-count", "0 items left");
    await expectVisible(view, ".clear-completed", true);
  });
});
