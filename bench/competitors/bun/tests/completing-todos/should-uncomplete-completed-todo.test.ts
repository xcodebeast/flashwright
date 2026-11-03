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
  test("should-uncomplete-completed-todo", async () => {
    await fill(view, ".new-todo", "Buy groceries");
      await view.press('Enter');
    await view.click(`${await itemOf(view, undefined)} .toggle`);
    await view.click(`${await itemOf(view, undefined)} .toggle`);
  });
});
