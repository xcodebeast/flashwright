// What a Bun.WebView user writes once to test with it.
const timeout = 5000;

// Views of one Bun process share a Chrome profile, and so localStorage: a test that finds the
// previous tests' todos clears them and reloads the app.
export async function openApp() {
  const view = new Bun.WebView({
    width: 1280,
    height: 720,
    backend: { type: 'chrome', path: process.env.CHROME_PATH!, url: false },
  });
  await view.navigate(process.env.APP_URL!);
  if (await view.evaluate('localStorage.length')) {
    await view.evaluate('localStorage.clear()');
    await view.reload();
  }
  return view;
}

export function closeApp(view: Bun.WebView) {
  view.close();
}

// Functions the conditions below use, evaluated in the page.
const pageHelpers = `
  const visible = element => !!element && element.checkVisibility();
  const items = () => [...document.querySelectorAll(".todo-list li")];
  const itemTitled = title => title === undefined ? items()[0] : items().find(item => item.querySelector('label')?.textContent === title);
`;

// Waits in the page, re-checking every animation frame, until the condition holds.
async function waitFor(view: Bun.WebView, condition: string, description: string) {
  const ok = await view.evaluate(`new Promise(resolve => {
    ${pageHelpers}
    const deadline = performance.now() + ${timeout};
    const check = () => {
      if (${condition}) resolve(true);
      else if (performance.now() > deadline) resolve(false);
      else requestAnimationFrame(check);
    };
    check();
  })`);
  if (!ok)
    throw new Error(`Timed out after ${timeout} ms waiting for ${description}`);
}

const literal = (value: unknown) => JSON.stringify(value);

// A selector for the todo with this title (or the only todo), once it exists.
export async function itemOf(view: Bun.WebView, title?: string) {
  await waitFor(view, `!!itemTitled(${literal(title)})`, `todo ${title ?? ''}`);
  const index = await view.evaluate(`(() => { ${pageHelpers} return items().indexOf(itemTitled(${literal(title)})); })()`) as number;
  return `.todo-list li:nth-child(${index + 1})`;
}

// Clicks the field to focus it, selects its text and types over it.
export async function fill(view: Bun.WebView, selector: string, text: string) {
  await view.click(selector);
  await view.evaluate(`document.querySelector(${literal(selector)}).select()`);
  if (text)
    await view.type(text);
  else
    await view.press('Backspace');
}

// Bun.WebView has no hover: move the mouse over the element's center with the DevTools protocol.
export async function hover(view: Bun.WebView, selector: string) {
  await waitFor(view, `visible(document.querySelector(${literal(selector)}))`, `${selector} to be visible`);
  const { x, y } = await view.evaluate(`(() => { const box = document.querySelector(${literal(selector)}).getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`) as { x: number, y: number };
  await view.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

export const expectText = (view: Bun.WebView, selector: string, text: string) =>
  waitFor(view, `document.querySelector(${literal(selector)})?.textContent === ${literal(text)}`, `${selector} to read "${text}"`);
export const expectTodo = (view: Bun.WebView, title: string, shown: boolean) =>
  waitFor(view, `visible([...document.querySelectorAll(".todo-list li label")].find(label => label.textContent === ${literal(title)})) === ${shown}`, `todo "${title}" to be ${shown ? 'visible' : 'hidden'}`);
export const expectVisible = (view: Bun.WebView, selector: string, shown: boolean) =>
  waitFor(view, `visible(document.querySelector(${literal(selector)})) === ${shown}`, `${selector} to be ${shown ? 'visible' : 'hidden'}`);
export const expectValue = (view: Bun.WebView, selector: string, value: string) =>
  waitFor(view, `document.querySelector(${literal(selector)})?.value === ${literal(value)}`, `${selector} to have value "${value}"`);
export const expectChecked = (view: Bun.WebView, title: string | undefined, checked: boolean) =>
  waitFor(view, `itemTitled(${literal(title)})?.querySelector('.toggle')?.checked === ${checked}`, `todo ${title ?? ''} to be ${checked ? 'checked' : 'unchecked'}`);
export const expectFocused = (view: Bun.WebView, selector: string) =>
  waitFor(view, `document.activeElement === document.querySelector(${literal(selector)})`, `${selector} to be focused`);
export const expectCount = (view: Bun.WebView, selector: string, count: number) =>
  waitFor(view, `document.querySelectorAll(${literal(selector)}).length === ${count}`, `${count} of ${selector}`);
export const expectTexts = (view: Bun.WebView, selector: string, texts: string[]) =>
  waitFor(view, `JSON.stringify([...document.querySelectorAll(${literal(selector)})].map(element => element.textContent)) === ${literal(JSON.stringify(texts))}`, `${selector} to read ${JSON.stringify(texts)}`);
export const expectUrlEnding = (view: Bun.WebView, suffix: string) =>
  waitFor(view, `location.href.endsWith(${literal(suffix)})`, `the URL to end with ${suffix}`);
