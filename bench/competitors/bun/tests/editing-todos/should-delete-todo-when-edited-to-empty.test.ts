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
  test("should delete todo when edited to empty", async () => {
    await fill(view, ".new-todo", "Temporary task");
      await view.press('Enter');
    await expectTodo(view, "Temporary task", true);
    await expectText(view, ".todo-count", "1 item left");
    await view.click(".todo-list li label", { clickCount: 2 });
    await expectVisible(view, ".todo-list li .edit", true);
    await fill(view, ".todo-list li .edit", "");
    await view.press("Enter");
    await expectTodo(view, "Temporary task", false);
    await expectVisible(view, ".todo-list li label", false);
  });
});
