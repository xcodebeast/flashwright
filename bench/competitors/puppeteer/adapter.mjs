// Puppeteer + Jest (jest-puppeteer) port of the scenarios. Actions use Puppeteer's Locator API,
// which waits for elements to be visible, enabled and stable; assertions wait with
// page.waitForSelector / page.waitForFunction, the way Puppeteer documents waiting.
import { parseTarget, selectors } from '../scenarios.mjs';

const json = JSON.stringify;

function emitTest(scenario) {
  let hovered;
  const css = name => json(selectors[name] ?? selectors[parseTarget(name).kind]);
  // Locators for actions: CSS for plain targets, an XPath that matches the todo's exact title otherwise.
  const locator = name => {
    const { kind, text } = parseTarget(name);
    if (kind === 'toggle' && text !== undefined)
      return `page.locator(toggleOf(${json(text)}))`;
    if (kind === 'delete')
      return `page.locator(deleteOf(${hovered}))`;
    if (kind === 'filter')
      return `page.locator(${json(selectors[name])})`;
    return `page.locator(${css(name)})`;
  };
  const lines = scenario.steps.map(([action, name, value]) => {
    const { kind, text } = typeof name === 'string' ? parseTarget(name) : {};
    switch (action) {
      case 'add': return `await page.locator(${json(selectors.new)}).fill(${json(name)});\n    await page.keyboard.press('Enter');`;
      // fill('') leaves React's state unchanged, so an empty value is selected and deleted instead.
      case 'fill': return value === ''
        ? `await ${locator(name)}.click({ count: 3 });\n    await page.keyboard.press('Backspace');`
        : `await ${locator(name)}.fill(${json(value)});`;
      case 'press': return `await page.keyboard.press(${json(value)});`;
      case 'click': return `await ${locator(name)}.click();`;
      case 'dblclick': return `await ${locator(name)}.click({ count: 2 });`;
      case 'hover':
        hovered = text === undefined ? 'undefined' : json(text);
        return `await page.locator(itemOf(${hovered})).hover();`;
      case 'visible':
        if (kind === 'counter')
          return `await expectText(${json(selectors.counter)}, ${json(text)});`;
        if (kind === 'todo')
          return `await page.waitForSelector(todoOf(${json(text)}), { visible: true, timeout });`;
        if (kind === 'delete')
          return `await page.waitForSelector(deleteOf(${hovered}), { visible: true, timeout });`;
        return `await page.waitForSelector(${css(name)}, { visible: true, timeout });`;
      case 'hidden':
        if (kind === 'todo')
          return `await page.waitForSelector(todoOf(${json(text)}), { hidden: true, timeout });`;
        return `await page.waitForSelector(${css(name)}, { hidden: true, timeout });`;
      case 'value': return `await expectValue(${css(name)}, ${json(value)});`;
      case 'checked': return `await expectChecked(${text === undefined ? 'undefined' : json(text)}, true);`;
      case 'unchecked': return `await expectChecked(${text === undefined ? 'undefined' : json(text)}, false);`;
      case 'focused': return `await expectFocused(${css(name)});`;
      case 'count': return `await expectCount(${json(selectors.item)}, ${name});`;
      case 'items': return `await expectTexts(${json(selectors.todoTitle)}, ${json(name)});`;
      case 'url': return `await expectUrlEnding(${json(name)});`;
      default: throw new Error(`Unknown step ${action}`);
    }
  });
  return `test(${json(scenario.title)}, async () => {\n${lines.map(line => `  ${line}\n`).join('')}});`;
}

const indent = text => text.replace(/^(?=.)/gm, '  ');

// One spec file for the scenarios that share a file, in scenario order, each under its describe.
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
  // jest-puppeteer opens a new incognito context and page for each test file; files with several
  // tests reset them before each test, as jest-puppeteer documents, so no test sees another's todos.
  const reset = group.length > 1 ? '  await jestPuppeteer.resetBrowser();\n' : '';
  return `const { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding } = require(${json(helpers)});

beforeEach(async () => {
${reset}  await page.goto(process.env.APP_URL);
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

const helpers = `// What a Puppeteer user writes once: selectors for a todo by its exact title, and assertions that
// wait for a condition (Puppeteer has no assertion library).
const timeout = 5000;

const literal = text => JSON.stringify(text);
const itemOf = text => text === undefined ? ${json(selectors.item)} : \`::-p-xpath(//ul[contains(@class,"todo-list")]/li[.//label[text()=\${literal(text)}]])\`;
const todoOf = text => \`::-p-xpath(//ul[contains(@class,"todo-list")]/li//label[text()=\${literal(text)}])\`;
const toggleOf = text => \`::-p-xpath(//ul[contains(@class,"todo-list")]/li[.//label[text()=\${literal(text)}]]//input[contains(@class,"toggle")])\`;
const deleteOf = text => text === undefined ? ${json(selectors.delete)} : \`::-p-xpath(//ul[contains(@class,"todo-list")]/li[.//label[text()=\${literal(text)}]]//button[contains(@class,"destroy")])\`;

const expectText = (selector, text) => page.waitForFunction((selector, text) => document.querySelector(selector)?.textContent === text, { timeout }, selector, text);
const expectValue = (selector, value) => page.waitForFunction((selector, value) => document.querySelector(selector)?.value === value, { timeout }, selector, value);
const expectChecked = (title, checked) => page.waitForFunction((title, checked) => {
  const items = [...document.querySelectorAll(${json(selectors.item)})];
  const item = title === undefined ? items[0] : items.find(item => item.querySelector('label')?.textContent === title);
  return item?.querySelector('.toggle')?.checked === checked;
}, { timeout }, title, checked);
const expectFocused = selector => page.waitForFunction(selector => document.activeElement === document.querySelector(selector), { timeout }, selector);
const expectCount = (selector, count) => page.waitForFunction((selector, count) => document.querySelectorAll(selector).length === count, { timeout }, selector, count);
const expectTexts = (selector, texts) => page.waitForFunction((selector, texts) => JSON.stringify([...document.querySelectorAll(selector)].map(element => element.textContent)) === JSON.stringify(texts), { timeout }, selector, texts);
const expectUrlEnding = suffix => page.waitForFunction(suffix => location.href.endsWith(suffix), { timeout }, suffix);

module.exports = { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding };
`;

export default {
  label: 'Puppeteer + Jest',
  package: 'puppeteer',
  kind: 'browser automation library + Jest',
  files: scenarios => [
    ...groupByFile(scenarios).map(([file, group]) => ({ path: `tests/${file}.test.js`, contents: emitFile(file, group) })),
    { path: 'tests/helpers.js', contents: helpers },
    { path: 'jest.config.cjs', contents: `module.exports = {
  preset: 'jest-puppeteer',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // Plain CommonJS tests: no Babel transform.
  transform: {},
  testTimeout: 30000,
};
` },
    { path: 'jest-puppeteer.config.cjs', contents: `module.exports = {
  launch: {
    executablePath: process.env.CHROME_PATH,
    headless: true,
    defaultViewport: { width: 1280, height: 720 },
  },
  // A new incognito context, and so empty localStorage, for every test file.
  browserContext: 'incognito',
};
` },
  ],
  command: ({ workers, node }) => ({ command: node, args: ['node_modules/jest/bin/jest.js', '--ci', `--maxWorkers=${workers}`], env: {} }),
  passed: output => Number(/Tests:\s+(?:\d+ \w+, )*?(\d+) passed/.exec(output)?.[1] ?? 0),
};
