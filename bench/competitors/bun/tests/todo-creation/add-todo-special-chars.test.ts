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
  test("Add todo with special characters", async () => {
    await expectVisible(view, ".new-todo", true);
    await fill(view, ".new-todo", "Buy @groceries & supplies (urgent!)");
      await view.press('Enter');
    await expectTodo(view, "Buy @groceries & supplies (urgent!)", true);
    await expectText(view, ".todo-count", "1 item left");
  });
});
