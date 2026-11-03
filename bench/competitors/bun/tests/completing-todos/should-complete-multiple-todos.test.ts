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
  test("should complete multiple todos", async () => {
    await fill(view, ".new-todo", "Buy milk");
      await view.press('Enter');
    await fill(view, ".new-todo", "Walk dog");
      await view.press('Enter');
    await fill(view, ".new-todo", "Finish report");
      await view.press('Enter');
    await expectTodo(view, "Buy milk", true);
    await expectTodo(view, "Walk dog", true);
    await expectTodo(view, "Finish report", true);
    await expectText(view, ".todo-count", "3 items left");
    await view.click(`${await itemOf(view, "Buy milk")} .toggle`);
    await expectChecked(view, "Buy milk", true);
    await expectText(view, ".todo-count", "2 items left");
    await view.click(`${await itemOf(view, "Finish report")} .toggle`);
    await expectChecked(view, "Finish report", true);
    await expectText(view, ".todo-count", "1 item left");
    await expectVisible(view, ".clear-completed", true);
  });
});
