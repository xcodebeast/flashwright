import { afterEach, beforeEach, describe, test } from 'bun:test';
import { openApp, closeApp, fill, hover, itemOf, expectText, expectTodo, expectVisible, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } from "../helpers";

let view: Bun.WebView;

beforeEach(async () => {
  view = await openApp();
});

afterEach(() => {
  closeApp(view);
});

describe("Todo Creation", () => {
  test("Add multiple todos", async () => {
    await expectVisible(view, ".new-todo", true);
    await fill(view, ".new-todo", "Buy groceries");
      await view.press('Enter');
    await expectTodo(view, "Buy groceries", true);
    await fill(view, ".new-todo", "Walk the dog");
      await view.press('Enter');
    await expectTodo(view, "Walk the dog", true);
    await fill(view, ".new-todo", "Read a book");
      await view.press('Enter');
    await expectTodo(view, "Read a book", true);
    await expectTodo(view, "Buy groceries", true);
    await expectTodo(view, "Walk the dog", true);
    await expectTodo(view, "Read a book", true);
    await expectText(view, ".todo-count", "3 items left");
    await expectChecked(view, "Buy groceries", false);
  });
});
