import { afterEach, beforeEach, describe, test } from 'bun:test';
import { openApp, closeApp, fill, hover, itemOf, expectText, expectTodo, expectVisible, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } from "../helpers";

let view: Bun.WebView;

beforeEach(async () => {
  view = await openApp();
});

afterEach(() => {
  closeApp(view);
});

describe("Deleting Todos", () => {
  test("should-clear-all-completed-todos", async () => {
    await fill(view, ".new-todo", "Task 1");
      await view.press('Enter');
    await fill(view, ".new-todo", "Task 2");
      await view.press('Enter');
    await fill(view, ".new-todo", "Task 3");
      await view.press('Enter');
    await expectTexts(view, ".todo-list li label", ["Task 1","Task 2","Task 3"]);
    await view.click(`${await itemOf(view, "Task 1")} .toggle`);
    await view.click(`${await itemOf(view, "Task 3")} .toggle`);
    await expectText(view, ".todo-count", "1 item left");
    await expectVisible(view, ".clear-completed", true);
    await view.click(".clear-completed");
    await expectTodo(view, "Task 2", true);
    await expectText(view, ".todo-count", "1 item left");
  });
});
