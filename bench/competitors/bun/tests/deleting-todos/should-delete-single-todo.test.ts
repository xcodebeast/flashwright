import { afterEach, beforeEach, describe, test } from 'bun:test';
import { openApp, closeApp, fill, hover, itemOf, expectText, expectTodo, expectVisible, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } from "../helpers";

let view: Bun.WebView;

beforeEach(async () => {
  view = await openApp();
});

afterEach(() => {
  closeApp(view);
});

describe("Deleting Todos", () => {
  test("should-delete-single-todo", async () => {
    await fill(view, ".new-todo", "Task to delete");
      await view.press('Enter');
    await expectTodo(view, "Task to delete", true);
    await expectText(view, ".todo-count", "1 item left");
    await hover(view, await itemOf(view, undefined));
    await expectVisible(view, `${await itemOf(view, undefined)} .destroy`, true);
    await view.click(`${await itemOf(view, undefined)} .destroy`);
    await expectTodo(view, "Task to delete", false);
    await expectVisible(view, ".todo-list li label", false);
  });
});
