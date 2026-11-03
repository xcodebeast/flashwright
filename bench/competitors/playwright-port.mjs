// Playwright Test port of the scenarios, shared by the `playwright` and `flashwright` frameworks:
// the same files run on stock @playwright/test and on flashwright-test.
import { parseTarget, selectors } from './scenarios.mjs';

const exact = text => `/^${text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$/`;
const todo = text => `page.locator(${JSON.stringify(selectors.todoTitle)}, { hasText: ${exact(text)} })`;
const item = text => text === undefined ? `page.locator(${JSON.stringify(selectors.item)})` : `page.locator(${JSON.stringify(selectors.item)}, { has: page.locator('label', { hasText: ${exact(text)} }) })`;

function emitTest(scenario) {
  let hovered;
  const target = name => {
    const { kind, text } = parseTarget(name);
    switch (kind) {
      case 'new': return `page.locator(${JSON.stringify(selectors.new)})`;
      case 'edit': return `page.locator(${JSON.stringify(selectors.edit)})`;
      case 'todo': return todo(text);
      case 'counter': return `page.locator(${JSON.stringify(selectors.counter)})`;
      case 'toggle': return text === undefined ? `page.locator(${JSON.stringify(selectors.toggle)})` : `${item(text)}.locator('.toggle')`;
      case 'filter': return `page.locator(${JSON.stringify(selectors[name])})`;
      case 'delete': return `${hovered}.locator('.destroy')`;
      default: return `page.locator(${JSON.stringify(selectors[kind])})`;
    }
  };
  const lines = scenario.steps.map(([action, name, value]) => {
    switch (action) {
      case 'add': return `await page.locator(${JSON.stringify(selectors.new)}).fill(${JSON.stringify(name)});\n  await page.locator(${JSON.stringify(selectors.new)}).press('Enter');`;
      case 'fill': return `await ${target(name)}.fill(${JSON.stringify(value)});`;
      case 'press': return `await ${target(name)}.press(${JSON.stringify(value)});`;
      case 'click': return `await ${target(name)}.click();`;
      case 'dblclick': return `await ${target(name)}.dblclick();`;
      case 'hover': hovered = item(parseTarget(name).text); return `await ${hovered}.hover();`;
      case 'visible': return parseTarget(name).kind === 'counter'
        ? `await expect(${target(name)}).toHaveText(${JSON.stringify(parseTarget(name).text)});`
        : `await expect(${target(name)}).toBeVisible();`;
      case 'hidden': return `await expect(${target(name)}).not.toBeVisible();`;
      case 'value': return `await expect(${target(name)}).toHaveValue(${JSON.stringify(value)});`;
      case 'checked': return `await expect(${target(name)}).toBeChecked();`;
      case 'unchecked': return `await expect(${target(name)}).not.toBeChecked();`;
      case 'focused': return `await expect(${target(name)}).toBeFocused();`;
      case 'count': return `await expect(page.locator(${JSON.stringify(selectors.item)})).toHaveCount(${name});`;
      case 'items': return `await expect(page.locator(${JSON.stringify(selectors.todoTitle)})).toHaveText(${JSON.stringify(name)});`;
      case 'url': return `await expect(page).toHaveURL(/${name.replace(/[/#]/g, '\\$&')}$/);`;
      default: throw new Error(`Unknown step ${action}`);
    }
  });
  return `test(${JSON.stringify(scenario.title)}, async ({ page }) => {\n${lines.map(line => `  ${line}\n`).join('')}});`;
}

// One file per `file`: its tests in order, each under its describe block.
function emitFile(scenarios) {
  const blocks = [];
  for (const scenario of scenarios) {
    const last = blocks.at(-1);
    if (last && scenario.describe && last.describe === scenario.describe)
      last.tests.push(emitTest(scenario));
    else
      blocks.push({ describe: scenario.describe, tests: [emitTest(scenario)] });
  }
  const indent = text => text.replace(/^(?=.)/gm, '  ');
  return `import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.APP_URL!);
});
${blocks.map(block => block.describe
    ? `\ntest.describe(${JSON.stringify(block.describe)}, () => {\n${block.tests.map(indent).join('\n\n')}\n});\n`
    : `\n${block.tests.join('\n\n')}\n`).join('')}`;
}

export function playwrightFiles(scenarios) {
  return [
    ...Map.groupBy(scenarios, scenario => scenario.file).entries().map(([file, group]) => ({ path: `tests/${file}.spec.ts`, contents: emitFile(group) })),
    { path: 'playwright.config.ts', contents: `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: Number(process.env.WORKERS),
  retries: 0,
  reporter: 'dot',
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: { executablePath: process.env.CHROME_PATH },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
` },
  ];
}

export const passedTests = output => Number(/(\d+) passed/.exec(output)?.[1] ?? 0);
