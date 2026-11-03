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
  test("should edit todo by double-clicking", async () => {
    await fill(view, ".new-todo", "Buy milk");
      await view.press('Enter');
    await expectTodo(view, "Buy milk", true);
    await view.click(".todo-list li label", { clickCount: 2 });
    await expectVisible(view, ".todo-list li .edit", true);
    await expectValue(view, ".todo-list li .edit", "Buy milk");
    await fill(view, ".todo-list li .edit", "Buy organic milk");
    await view.press("Enter");
    await expectTodo(view, "Buy organic milk", true);
  });
});
