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
  test("should trim whitespace from new todo", async () => {
    await fill(view, ".new-todo", "   Todo with spaces   ");
      await view.press('Enter');
    await expectTodo(view, "Todo with spaces", true);
    await expectText(view, ".todo-count", "1 item left");
  });
});
