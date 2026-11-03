import { afterEach, beforeEach, describe, test } from 'bun:test';
import { openApp, closeApp, fill, hover, itemOf, expectText, expectTodo, expectVisible, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } from "./helpers";

let view: Bun.WebView;

beforeEach(async () => {
  view = await openApp();
});

afterEach(() => {
  closeApp(view);
});

test("seed", async () => {
});
