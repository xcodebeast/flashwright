import { afterEach, beforeEach, describe, test } from 'bun:test';
import { openApp, closeApp, fill, hover, itemOf, expectText, expectTodo, expectVisible, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } from "../helpers";

let view: Bun.WebView;

beforeEach(async () => {
  view = await openApp();
});

afterEach(() => {
  closeApp(view);
});

describe("Completing Todos", () => {
  test("should-complete-single-todo", async () => {
    await fill(view, ".new-todo", "Buy groceries");
      await view.press('Enter');
    await expectTodo(view, "Buy groceries", true);
    await expectText(view, ".todo-count", "1 item left");
    await view.click(`${await itemOf(view, undefined)} .toggle`);
    await expectChecked(view, undefined, true);
    await expectText(view, ".todo-count", "0 items left");
    await expectVisible(view, ".clear-completed", true);
  });
});
