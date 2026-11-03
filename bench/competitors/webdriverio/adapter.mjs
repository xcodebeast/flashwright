// WebdriverIO port: `$()` element queries with WebdriverIO's automatic waiting, and the
// expect-webdriverio matchers, which retry until `waitforTimeout`.
import { parseTarget, selectors } from '../scenarios.mjs';

// Exact text matches use XPath, the selector strategy WebdriverIO documents for text.
const xpathString = text => text.includes("'") ? `concat('${text.split("'").join(`', "'", '`)}')` : `'${text}'`;
const todo = text => `//ul[@class='todo-list']/li//label[.=${xpathString(text)}]`;
const item = text => text === undefined ? selectors.item : `//ul[@class='todo-list']/li[.//label[.=${xpathString(text)}]]`;
const q = value => JSON.stringify(value);

function emitTest(scenario) {
  let hovered;
  const element = name => {
    const { kind, text } = parseTarget(name);
    switch (kind) {
      case 'todo': return `$(${q(todo(text))})`;
      case 'toggle': return text === undefined ? `$(${q(selectors.toggle)})` : `$(${q(item(text))}).$('.toggle')`;
      case 'filter': return `$(${q(selectors[name])})`;
      case 'delete': return `$(${q(hovered)}).$('.destroy')`;
      default: return `$(${q(selectors[kind])})`;
    }
  };
  const lines = scenario.steps.map(([action, name, value]) => {
    switch (action) {
      case 'add': return `await $(${q(selectors.new)}).setValue(${q(name)});\n    await browser.keys('Enter');`;
      // setValue() clears with WebDriver's Element Clear, which blurs the field: blur ends
      // TodoMVC's edit mode, so the edit field is replaced the way a user does it.
      case 'fill': return name === 'edit'
        ? `await browser.keys([Key.Ctrl, 'a']);\n    await ${value ? `${element(name)}.addValue(${q(value)})` : `browser.keys('Backspace')`};`
        : `await ${element(name)}.setValue(${q(value)});`;
      case 'press': return `await browser.keys(${q(value)});`;
      case 'click': return `await ${element(name)}.click();`;
      case 'dblclick': return `await ${element(name)}.doubleClick();`;
      case 'hover': hovered = item(parseTarget(name).text); return `await $(${q(hovered)}).moveTo();`;
      case 'visible': return parseTarget(name).kind === 'counter'
        ? `await expect(${element(name)}).toHaveText(${q(parseTarget(name).text)});`
        : `await expect(${element(name)}).toBeDisplayed();`;
      case 'hidden': return `await expect(${element(name)}).not.toBeDisplayed();`;
      case 'value': return `await expect(${element(name)}).toHaveValue(${q(value)}${value !== value.trim() ? ', { trim: false }' : ''});`;
      case 'checked': return `await expect(${element(name)}).toBeSelected();`;
      case 'unchecked': return `await expect(${element(name)}).not.toBeSelected();`;
      case 'focused': return `await expect(${element(name)}).toBeFocused();`;
      case 'count': return `await expect($$(${q(selectors.item)})).toBeElementsArrayOfSize(${name});`;
      case 'items': return `await expect($$(${q(selectors.todoTitle)})).toHaveText(${q(name)});`;
      case 'url': return `await expect(browser).toHaveUrl(${q(name)}, { containing: true });`;
      default: throw new Error(`Unknown step ${action}`);
    }
  });
  return `  it(${q(scenario.title)}, async () => {
${lines.map(line => `    ${line}\n`).join('')}  });
`;
}

// One spec file per `file`: its scenarios in order, under their describe blocks.
function emitFile(scenarios) {
  const groups = [];
  for (const scenario of scenarios) {
    const describe = scenario.describe ?? 'Seed';
    if (groups.at(-1)?.describe !== describe)
      groups.push({ describe, scenarios: [] });
    groups.at(-1).scenarios.push(scenario);
  }
  const usesKey = scenarios.some(scenario => scenario.steps.some(([action, name]) => action === 'fill' && name === 'edit'));
  // A spec file gets a browser session of its own. When its tests share it, each one starts from
  // empty storage: navigate, clear (the previous page may save todos as it unloads), reload.
  const reset = scenarios.length > 1 ? `
    await browser.execute(() => localStorage.clear());
    await browser.refresh();` : '';
  return `import { browser, $, $$, expect } from '@wdio/globals';
${usesKey ? "import { Key } from 'webdriverio';\n" : ''}${groups.map(group => `
describe(${q(group.describe)}, () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);${reset}
  });

${group.scenarios.map(emitTest).join('\n')}});
`).join('')}`;
}

function specFiles(scenarios, extension) {
  const files = new Map();
  for (const scenario of scenarios)
    files.set(scenario.file, [...(files.get(scenario.file) ?? []), scenario]);
  return [...files].map(([file, fileScenarios]) => ({ path: `tests/${file}${extension}`, contents: emitFile(fileScenarios) }));
}

const config = `export const config = {
  runner: 'local',
  specs: ['./tests/**/*.spec.js'],
  maxInstances: Number(process.env.WORKERS),
  capabilities: [{
    browserName: 'chrome',
    'goog:chromeOptions': {
      binary: process.env.CHROME_PATH,
      args: ['--headless=new', '--window-size=1280,720'],
    },
    'wdio:chromedriverOptions': { binary: process.env.CHROMEDRIVER_PATH },
    // WebdriverIO opens a WebDriver BiDi connection by default; WDIO_CLASSIC=1 measures without.
    ...(process.env.WDIO_CLASSIC === '1' && { 'wdio:enforceWebDriverClassic': true }),
  }],
  logLevel: 'error',
  bail: 0,
  waitforTimeout: 5000,
  connectionRetryCount: 0,
  framework: 'mocha',
  reporters: ['dot'],
  mochaOpts: { ui: 'bdd', timeout: 30000 },
};
`;

export default {
  label: 'WebdriverIO',
  package: 'webdriverio',
  kind: 'test framework',
  files: scenarios => [
    ...specFiles(scenarios, '.spec.js'),
    { path: 'wdio.conf.js', contents: config },
  ],
  command: ({ node }) => ({ command: node, args: ['node_modules/@wdio/cli/bin/wdio.js', 'run', 'wdio.conf.js'], env: {} }),
  // The dot reporter prints one "." per passed test (F failed, - skipped) after its title.
  passed: output => (/"dot" Reporter:\s*\n([.F-]+)/.exec(output)?.[1].match(/\./g) ?? []).length,
};
