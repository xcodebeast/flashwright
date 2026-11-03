// `bun test` + Bun.WebView port of the scenarios. Bun.WebView is a browser automation API, not a
// test framework: click(selector) waits for the element to be actionable, but there are no
// locators by text, no fill, no hover and no assertions, so tests/helpers.ts adds what a user
// would write: a page-side wait for conditions, fill by select-and-type, and hover over CDP.
import { parseTarget, selectors } from '../scenarios.mjs';

const json = JSON.stringify;

function emitTest(scenario) {
  let hovered;
  const css = name => json(selectors[name] ?? selectors[parseTarget(name).kind]);
  const lines = scenario.steps.map(([action, name, value]) => {
    const { kind, text } = typeof name === 'string' ? parseTarget(name) : {};
    const title = text === undefined ? 'undefined' : json(text);
    switch (action) {
      case 'add': return `await fill(view, ${json(selectors.new)}, ${json(name)});\n    await view.press('Enter');`;
      case 'fill': return `await fill(view, ${css(name)}, ${json(value)});`;
      case 'press': return `await view.press(${json(value)});`;
      case 'click':
        if (kind === 'toggle')
          return `await view.click(\`\${await itemOf(view, ${title})} .toggle\`);`;
        if (kind === 'delete')
          return `await view.click(\`\${await itemOf(view, ${hovered})} .destroy\`);`;
        return `await view.click(${css(name)});`;
      case 'dblclick': return `await view.click(${css(name)}, { clickCount: 2 });`;
      case 'hover':
        hovered = title;
        return `await hover(view, await itemOf(view, ${hovered}));`;
      case 'visible':
        if (kind === 'counter')
          return `await expectText(view, ${json(selectors.counter)}, ${json(text)});`;
        if (kind === 'todo')
          return `await expectTodo(view, ${json(text)}, true);`;
        if (kind === 'delete')
          return `await expectVisible(view, \`\${await itemOf(view, ${hovered})} .destroy\`, true);`;
        return `await expectVisible(view, ${css(name)}, true);`;
      case 'hidden':
        if (kind === 'todo')
          return `await expectTodo(view, ${json(text)}, false);`;
        return `await expectVisible(view, ${css(name)}, false);`;
      case 'value': return `await expectValue(view, ${css(name)}, ${json(value)});`;
      case 'checked': return `await expectChecked(view, ${title}, true);`;
      case 'unchecked': return `await expectChecked(view, ${title}, false);`;
      case 'focused': return `await expectFocused(view, ${css(name)});`;
      case 'count': return `await expectCount(view, ${json(selectors.item)}, ${name});`;
      case 'items': return `await expectTexts(view, ${json(selectors.todoTitle)}, ${json(name)});`;
      case 'url': return `await expectUrlEnding(view, ${json(name)});`;
      default: throw new Error(`Unknown step ${action}`);
    }
  });
  return `test(${json(scenario.title)}, async () => {\n${lines.map(line => `  ${line}\n`).join('')}});`;
}

const indent = text => text.replace(/^(?=.)/gm, '  ');

// One spec file for the scenarios that share a file, in scenario order, each under its describe.
// Every test opens its own view (openApp), so tests in one file stay isolated.
function emitFile(file, group) {
  const depth = file.split('/').length - 1;
  const helpers = depth ? '../'.repeat(depth) + 'helpers' : './helpers';
  const blocks = [];
  for (const scenario of group) {
    const last = blocks.at(-1);
    if (last && scenario.describe && last.describe === scenario.describe)
      last.tests.push(emitTest(scenario));
    else
      blocks.push({ describe: scenario.describe, tests: [emitTest(scenario)] });
  }
  return `import { afterEach, beforeEach, describe, test } from 'bun:test';
import { openApp, closeApp, fill, hover, itemOf, expectText, expectTodo, expectVisible, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } from ${json(helpers)};

let view: Bun.WebView;

beforeEach(async () => {
  view = await openApp();
});

afterEach(() => {
  closeApp(view);
});

${blocks.map(({ describe, tests }) => describe
    ? `describe(${json(describe)}, () => {\n${tests.map(indent).join('\n\n')}\n});\n`
    : `${tests.join('\n\n')}\n`).join('\n')}`;
}

const groupByFile = scenarios => {
  const groups = new Map();
  for (const scenario of scenarios)
    groups.set(scenario.file, [...(groups.get(scenario.file) ?? []), scenario]);
  return [...groups];
};

const helpers = `// What a Bun.WebView user writes once to test with it.
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
const pageHelpers = \`
  const visible = element => !!element && element.checkVisibility();
  const items = () => [...document.querySelectorAll(${json(selectors.item)})];
  const itemTitled = title => title === undefined ? items()[0] : items().find(item => item.querySelector('label')?.textContent === title);
\`;

// Waits in the page, re-checking every animation frame, until the condition holds.
async function waitFor(view: Bun.WebView, condition: string, description: string) {
  const ok = await view.evaluate(\`new Promise(resolve => {
    \${pageHelpers}
    const deadline = performance.now() + \${timeout};
    const check = () => {
      if (\${condition}) resolve(true);
      else if (performance.now() > deadline) resolve(false);
      else requestAnimationFrame(check);
    };
    check();
  })\`);
  if (!ok)
    throw new Error(\`Timed out after \${timeout} ms waiting for \${description}\`);
}

const literal = (value: unknown) => JSON.stringify(value);

// A selector for the todo with this title (or the only todo), once it exists.
export async function itemOf(view: Bun.WebView, title?: string) {
  await waitFor(view, \`!!itemTitled(\${literal(title)})\`, \`todo \${title ?? ''}\`);
  const index = await view.evaluate(\`(() => { \${pageHelpers} return items().indexOf(itemTitled(\${literal(title)})); })()\`) as number;
  return \`${selectors.item}:nth-child(\${index + 1})\`;
}

// Clicks the field to focus it, selects its text and types over it.
export async function fill(view: Bun.WebView, selector: string, text: string) {
  await view.click(selector);
  await view.evaluate(\`document.querySelector(\${literal(selector)}).select()\`);
  if (text)
    await view.type(text);
  else
    await view.press('Backspace');
}

// Bun.WebView has no hover: move the mouse over the element's center with the DevTools protocol.
export async function hover(view: Bun.WebView, selector: string) {
  await waitFor(view, \`visible(document.querySelector(\${literal(selector)}))\`, \`\${selector} to be visible\`);
  const { x, y } = await view.evaluate(\`(() => { const box = document.querySelector(\${literal(selector)}).getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()\`) as { x: number, y: number };
  await view.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

export const expectText = (view: Bun.WebView, selector: string, text: string) =>
  waitFor(view, \`document.querySelector(\${literal(selector)})?.textContent === \${literal(text)}\`, \`\${selector} to read "\${text}"\`);
export const expectTodo = (view: Bun.WebView, title: string, shown: boolean) =>
  waitFor(view, \`visible([...document.querySelectorAll(${json(selectors.todoTitle)})].find(label => label.textContent === \${literal(title)})) === \${shown}\`, \`todo "\${title}" to be \${shown ? 'visible' : 'hidden'}\`);
export const expectVisible = (view: Bun.WebView, selector: string, shown: boolean) =>
  waitFor(view, \`visible(document.querySelector(\${literal(selector)})) === \${shown}\`, \`\${selector} to be \${shown ? 'visible' : 'hidden'}\`);
export const expectValue = (view: Bun.WebView, selector: string, value: string) =>
  waitFor(view, \`document.querySelector(\${literal(selector)})?.value === \${literal(value)}\`, \`\${selector} to have value "\${value}"\`);
export const expectChecked = (view: Bun.WebView, title: string | undefined, checked: boolean) =>
  waitFor(view, \`itemTitled(\${literal(title)})?.querySelector('.toggle')?.checked === \${checked}\`, \`todo \${title ?? ''} to be \${checked ? 'checked' : 'unchecked'}\`);
export const expectFocused = (view: Bun.WebView, selector: string) =>
  waitFor(view, \`document.activeElement === document.querySelector(\${literal(selector)})\`, \`\${selector} to be focused\`);
export const expectCount = (view: Bun.WebView, selector: string, count: number) =>
  waitFor(view, \`document.querySelectorAll(\${literal(selector)}).length === \${count}\`, \`\${count} of \${selector}\`);
export const expectTexts = (view: Bun.WebView, selector: string, texts: string[]) =>
  waitFor(view, \`JSON.stringify([...document.querySelectorAll(\${literal(selector)})].map(element => element.textContent)) === \${literal(JSON.stringify(texts))}\`, \`\${selector} to read \${JSON.stringify(texts)}\`);
export const expectUrlEnding = (view: Bun.WebView, suffix: string) =>
  waitFor(view, \`location.href.endsWith(\${literal(suffix)})\`, \`the URL to end with \${suffix}\`);
`;

export default {
  label: 'Bun test + Bun.WebView',
  package: 'bun',
  kind: 'browser automation API + bun test',
  files: scenarios => [
    ...groupByFile(scenarios).map(([file, group]) => ({ path: `tests/${file}.test.ts`, contents: emitFile(file, group) })),
    { path: 'tests/helpers.ts', contents: helpers },
  ],
  // One worker runs every file in one process; more workers run files in parallel processes, each
  // with its own Chrome (Bun starts one Chrome per process).
  command: ({ workers, bun }) => ({ command: bun, args: ['test', './tests', '--timeout=30000', '--dots', ...(workers > 1 ? [`--parallel=${workers}`] : [])], env: {} }),
  passed: output => Number(/(\d+) pass\b/.exec(output)?.[1] ?? 0),
};
