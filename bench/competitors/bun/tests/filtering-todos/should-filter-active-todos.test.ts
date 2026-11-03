import { afterEach, beforeEach, describe, test } from 'bun:test';
import { openApp, closeApp, fill, hover, itemOf, expectText, expectTodo, expectVisible, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } from "../helpers";

let view: Bun.WebView;

beforeEach(async () => {
  view = await openApp();
});

afterEach(() => {
  closeApp(view);
});

describe("Filtering Todos", () => {
  test("should-filter-active-todos", async () => {
    await fill(view, ".new-todo", "Active 1");
      await view.press('Enter');
    await fill(view, ".new-todo", "Active 2");
      await view.press('Enter');
    await fill(view, ".new-todo", "Will complete");
      await view.press('Enter');
    await expectTodo(view, "Active 1", true);
    await expectTodo(view, "Active 2", true);
    await expectTodo(view, "Will complete", true);
    await view.click(`${await itemOf(view, "Will complete")} .toggle`);
    await expectChecked(view, "Will complete", true);
    await expectText(view, ".todo-count", "2 items left");
    await view.click(".filters a[href=\"#/active\"]");
    await expectUrlEnding(view, "#/active");
    await expectTodo(view, "Active 1", true);
    await expectTodo(view, "Active 2", true);
    await expectTodo(view, "Will complete", false);
    await expectVisible(view, ".filters a[href=\"#/active\"]", true);
  });
});
