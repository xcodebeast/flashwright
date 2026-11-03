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
  test("should not add empty todo", async () => {
    await view.click(".new-todo");
    await expectFocused(view, ".new-todo");
    await view.press("Enter");
    await expectVisible(view, ".todo-list", false);
  });
});
