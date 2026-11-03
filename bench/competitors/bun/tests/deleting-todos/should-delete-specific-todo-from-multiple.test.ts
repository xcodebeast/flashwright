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
  test("should-delete-specific-todo-from-multiple", async () => {
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
    await hover(view, await itemOf(view, "Task 2"));
    await view.click(`${await itemOf(view, "Task 2")} .destroy`);
    await expectTodo(view, "Task 1", true);
    await expectTodo(view, "Task 3", true);
    await expectText(view, ".todo-count", "2 items left");
  });
});
