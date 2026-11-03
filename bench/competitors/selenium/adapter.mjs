// Selenium WebDriver port, run by Mocha. Selenium doesn't wait on its own: every step waits
// explicitly with driver.wait() and `until` conditions (or a condition function), Selenium's
// documented practice; tests/support.mjs holds the waits the tests share.
import { parseTarget, selectors } from '../scenarios.mjs';

const xpathString = text => text.includes("'") ? `concat('${text.split("'").join(`', "'", '`)}')` : `'${text}'`;
const q = value => JSON.stringify(value);
const css = selector => `By.css(${q(selector)})`;
const todo = text => `By.xpath(${q(`//ul[@class='todo-list']/li//label[.=${xpathString(text)}]`)})`;
const item = text => text === undefined ? css(selectors.item) : `By.xpath(${q(`//ul[@class='todo-list']/li[.//label[.=${xpathString(text)}]]`)})`;

function emitTest(scenario) {
  let hovered;
  const locator = name => {
    const { kind, text } = parseTarget(name);
    switch (kind) {
      case 'todo': return todo(text);
      case 'toggle': return text === undefined ? css(selectors.toggle) : `By.xpath(${q(`//ul[@class='todo-list']/li[.//label[.=${xpathString(text)}]]//input[contains(@class,'toggle')]`)})`;
      case 'filter': return css(selectors[name]);
      case 'delete': return hovered === css(selectors.item) ? css(selectors.delete) : `By.xpath(${q(`${JSON.parse(hovered.slice('By.xpath('.length, -1))}//button[@class='destroy']`)})`;
      default: return css(selectors[kind]);
    }
  };
  const lines = scenario.steps.map(([action, name, value]) => {
    switch (action) {
      case 'add': return `await (await visible(${css(selectors.new)})).sendKeys(${q(name)}, Key.ENTER);`;
      // WebElement.clear() is WebDriver's Element Clear, which blurs the field: blur ends
      // TodoMVC's edit mode, so the edit field is replaced the way a user does it.
      case 'fill': return name === 'edit'
        ? `await (await visible(${locator(name)})).sendKeys(Key.chord(Key.CONTROL, 'a'), ${value ? q(value) : 'Key.BACK_SPACE'});`
        : `await (await visible(${locator(name)})).clear();\n    await (await visible(${locator(name)})).sendKeys(${q(value)});`;
      case 'press': return `await (await visible(${locator(name)})).sendKeys(Key.${value === 'Enter' ? 'ENTER' : 'ESCAPE'});`;
      // TodoMVC draws its checkboxes with opacity 0 behind an image, which isDisplayed() calls
      // hidden: a toggle click waits for the checkbox to exist and be enabled.
      case 'click': return parseTarget(name).kind === 'toggle'
        ? `await (await enabled(${locator(name)})).click();`
        : `await (await visible(${locator(name)})).click();`;
      case 'dblclick': return `await driver.actions().doubleClick(await visible(${locator(name)})).perform();`;
      case 'hover': hovered = item(parseTarget(name).text); return `await driver.actions().move({ origin: await visible(${hovered}) }).perform();`;
      case 'visible': return parseTarget(name).kind === 'counter'
        ? `await textIs(${locator(name)}, ${q(parseTarget(name).text)});`
        : `await visible(${locator(name)});`;
      case 'hidden': return `await hidden(${locator(name)});`;
      case 'value': return `await valueIs(${locator(name)}, ${q(value)});`;
      case 'checked': return `await selectedIs(${locator(name)}, true);`;
      case 'unchecked': return `await selectedIs(${locator(name)}, false);`;
      case 'focused': return `await focused(${locator(name)});`;
      case 'count': return `await countIs(${css(selectors.item)}, ${name});`;
      case 'items': return `await textsAre(${css(selectors.todoTitle)}, ${q(name)});`;
      case 'url': return `await driver.wait(until.urlContains(${q(name)}), TIMEOUT);`;
      default: throw new Error(`Unknown step ${action}`);
    }
  });
  return `  it(${q(scenario.title)}, async function () {
${lines.map(line => `    ${line}\n`).join('')}  });
`;
}

// One spec file per `file`: its scenarios in order, under their describe blocks, which share a
// browser (Mocha's root hooks would apply to every file, so the driver hooks live in describe).
// Tests that share a browser start from empty storage: navigate, clear (the previous page may
// save todos as it unloads), reload.
function emitFile(file, scenarios) {
  const groups = [];
  for (const scenario of scenarios) {
    const describe = scenario.describe ?? 'Seed';
    if (groups.at(-1)?.describe !== describe)
      groups.push({ describe, scenarios: [] });
    groups.at(-1).scenarios.push(scenario);
  }
  const depth = file.split('/').length - 1;
  return `import { By, Key, until } from 'selenium-webdriver';
import { TIMEOUT, countIs, createDriver, enabled, focused, hidden, selectedIs, textIs, textsAre, valueIs, visible, use } from '${depth ? '../'.repeat(depth) : './'}support.mjs';
${groups.map(group => `
describe(${q(group.describe)}, function () {
  let driver;

  before(async function () {
    driver = await createDriver();
    use(driver);
  });

  after(async function () {
    await driver?.quit();
  });

  beforeEach(async function () {
    await driver.get(process.env.APP_URL);${group.scenarios.length > 1 ? `
    await driver.executeScript('localStorage.clear()');
    await driver.navigate().refresh();` : ''}
  });

${group.scenarios.map(emitTest).join('\n')}});
`).join('')}`;
}

function specFiles(scenarios) {
  const files = new Map();
  for (const scenario of scenarios)
    files.set(scenario.file, [...(files.get(scenario.file) ?? []), scenario]);
  return [...files].map(([file, fileScenarios]) => ({ path: `tests/${file}.spec.mjs`, contents: emitFile(file, fileScenarios) }));
}

const support = `import { Builder, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';

export const TIMEOUT = 5000;
let driver;

export async function createDriver() {
  const options = new chrome.Options()
    .setChromeBinaryPath(process.env.CHROME_PATH)
    .addArguments('--headless=new', '--window-size=1280,720');
  return new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .setChromeService(new chrome.ServiceBuilder(process.env.CHROMEDRIVER_PATH))
    .build();
}

export function use(current) {
  driver = current;
}

// A condition that is retried while the element is missing or was re-rendered.
const retrying = condition => async () => {
  try {
    return await condition();
  } catch (error) {
    if (error.name === 'NoSuchElementError' || error.name === 'StaleElementReferenceError')
      return false;
    throw error;
  }
};

export async function visible(locator) {
  const element = await driver.wait(until.elementLocated(locator), TIMEOUT);
  await driver.wait(until.elementIsVisible(element), TIMEOUT);
  return element;
}

export async function enabled(locator) {
  const element = await driver.wait(until.elementLocated(locator), TIMEOUT);
  await driver.wait(until.elementIsEnabled(element), TIMEOUT);
  return element;
}

export async function hidden(locator) {
  await driver.wait(retrying(async () => {
    for (const element of await driver.findElements(locator)) {
      if (await element.isDisplayed())
        return false;
    }
    return true;
  }), TIMEOUT);
}

export async function textIs(locator, text) {
  await driver.wait(retrying(async () => await driver.findElement(locator).getText() === text), TIMEOUT);
}

export async function textsAre(locator, texts) {
  await driver.wait(retrying(async () => {
    const actual = await Promise.all((await driver.findElements(locator)).map(element => element.getText()));
    return JSON.stringify(actual) === JSON.stringify(texts);
  }), TIMEOUT);
}

export async function valueIs(locator, value) {
  await driver.wait(retrying(async () => await driver.findElement(locator).getAttribute('value') === value), TIMEOUT);
}

export async function selectedIs(locator, selected) {
  await driver.wait(retrying(async () => await driver.findElement(locator).isSelected() === selected), TIMEOUT);
}

export async function focused(locator) {
  await driver.wait(retrying(async () => await (await driver.switchTo().activeElement()).getId() === await driver.findElement(locator).getId()), TIMEOUT);
}

export async function countIs(locator, count) {
  await driver.wait(async () => (await driver.findElements(locator)).length === count, TIMEOUT);
}
`;

export default {
  label: 'Selenium + Mocha',
  package: 'selenium-webdriver',
  kind: 'browser automation library + Mocha',
  files: scenarios => [
    ...specFiles(scenarios),
    { path: 'tests/support.mjs', contents: support },
    { path: '.mocharc.cjs', contents: `const workers = Number(process.env.WORKERS);

module.exports = {
  spec: 'tests/**/*.spec.mjs',
  reporter: 'dot',
  timeout: 30000,
  ...(workers > 1 ? { parallel: true, jobs: workers } : {}),
};
` },
  ],
  command: ({ node }) => ({ command: node, args: ['node_modules/mocha/bin/mocha.js'], env: {} }),
  passed: output => Number(/(\d+) passing/.exec(output)?.[1] ?? 0),
};
