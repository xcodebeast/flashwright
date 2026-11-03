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
  test("should add multiple todos", async () => {
    await fill(view, ".new-todo", "Buy milk");
      await view.press('Enter');
    await expectTodo(view, "Buy milk", true);
    await expectText(view, ".todo-count", "1 item left");
    await fill(view, ".new-todo", "Walk the dog");
      await view.press('Enter');
    await expectTodo(view, "Buy milk", true);
    await expectTodo(view, "Walk the dog", true);
    await expectText(view, ".todo-count", "2 items left");
    await fill(view, ".new-todo", "Finish report");
      await view.press('Enter');
    await expectTodo(view, "Buy milk", true);
    await expectTodo(view, "Walk the dog", true);
    await expectTodo(view, "Finish report", true);
    await expectText(view, ".todo-count", "3 items left");
  });
});
