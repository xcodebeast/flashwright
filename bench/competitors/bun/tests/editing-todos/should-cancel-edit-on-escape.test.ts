import { afterEach, beforeEach, describe, test } from 'bun:test';
import { openApp, closeApp, fill, hover, itemOf, expectText, expectTodo, expectVisible, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } from "../helpers";

let view: Bun.WebView;

beforeEach(async () => {
  view = await openApp();
});

afterEach(() => {
  closeApp(view);
});

describe("Editing Todos", () => {
  test("should-cancel-edit-on-escape", async () => {
    await fill(view, ".new-todo", "Original text");
      await view.press('Enter');
    await expectTodo(view, "Original text", true);
    await view.click(".todo-list li label", { clickCount: 2 });
    await expectValue(view, ".todo-list li .edit", "Original text");
    await fill(view, ".todo-list li .edit", "Modified text");
    await view.press("Escape");
    await expectTodo(view, "Original text", true);
  });
});
