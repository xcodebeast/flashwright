import { afterEach, beforeEach, describe, test } from 'bun:test';
import { openApp, closeApp, fill, hover, itemOf, expectText, expectTodo, expectVisible, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } from "../helpers";

let view: Bun.WebView;

beforeEach(async () => {
  view = await openApp();
});

afterEach(() => {
  closeApp(view);
});

describe("Adding Todos", () => {
  test("should add single todo", async () => {
    await expectVisible(view, ".new-todo", true);
    await fill(view, ".new-todo", "Buy groceries");
    await expectValue(view, ".new-todo", "Buy groceries");
    await view.press("Enter");
    await expectTodo(view, "Buy groceries", true);
    await expectValue(view, ".new-todo", "");
    await expectText(view, ".todo-count", "1 item left");
  });
});
