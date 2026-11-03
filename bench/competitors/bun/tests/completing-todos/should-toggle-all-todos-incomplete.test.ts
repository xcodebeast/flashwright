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
  test("should toggle all todos incomplete", async () => {
    await fill(view, ".new-todo", "First todo");
      await view.press('Enter');
    await fill(view, ".new-todo", "Second todo");
      await view.press('Enter');
    await fill(view, ".new-todo", "Third todo");
      await view.press('Enter');
    await view.click("label[for=\"toggle-all\"]");
    await expectText(view, ".todo-count", "0 items left");
    await view.click("label[for=\"toggle-all\"]");
    await expectText(view, ".todo-count", "3 items left");
  });
});
