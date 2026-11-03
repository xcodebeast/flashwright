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
  test("Prevent adding empty todo", async () => {
    await expectVisible(view, ".new-todo", true);
    await view.click(".new-todo");
    await view.press("Enter");
    await expectCount(view, ".todo-list li", 0);
    await expectValue(view, ".new-todo", "");
  });
});
