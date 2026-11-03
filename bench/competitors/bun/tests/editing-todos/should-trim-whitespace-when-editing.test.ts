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
  test("should trim whitespace when editing", async () => {
    await fill(view, ".new-todo", "Original task");
      await view.press('Enter');
    await expectTodo(view, "Original task", true);
    await view.click(".todo-list li label", { clickCount: 2 });
    await fill(view, ".todo-list li .edit", "   Edited task   ");
    await expectValue(view, ".todo-list li .edit", "   Edited task   ");
    await view.press("Enter");
    await expectTodo(view, "Edited task", true);
  });
});
