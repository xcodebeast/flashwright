import { afterEach, beforeEach, describe, test } from 'bun:test';
import { openApp, closeApp, fill, hover, itemOf, expectText, expectTodo, expectVisible, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } from "../helpers";

let view: Bun.WebView;

beforeEach(async () => {
  view = await openApp();
});

afterEach(() => {
  closeApp(view);
});

describe("Editing Todos", () => {
  test("should-save-edit-on-blur", async () => {
    await fill(view, ".new-todo", "Call dentist");
      await view.press('Enter');
    await view.click(".todo-list li label", { clickCount: 2 });
    await fill(view, ".todo-list li .edit", "Schedule dentist appointment");
    await view.click(".header h1");
    await expectTodo(view, "Schedule dentist appointment", true);
  });
});
