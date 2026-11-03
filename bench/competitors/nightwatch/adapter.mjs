// Nightwatch port: Nightwatch's commands wait for their element (waitForConditionTimeout) and
// its `expect` assertions retry until it passes, so the tests need no waits of their own.
import { parseTarget, selectors } from '../scenarios.mjs';

const xpathString = text => text.includes("'") ? `concat('${text.split("'").join(`', "'", '`)}')` : `'${text}'`;
const q = value => JSON.stringify(value);
const xpath = path => `{ selector: ${q(path)}, locateStrategy: 'xpath' }`;
const itemPath = text => `//ul[@class='todo-list']/li[.//label[.=${xpathString(text)}]]`;

function emitTest(scenario) {
  let hovered;
  const element = name => {
    const { kind, text } = parseTarget(name);
    switch (kind) {
      case 'todo': return xpath(`//ul[@class='todo-list']/li//label[.=${xpathString(text)}]`);
      case 'toggle': return text === undefined ? q(selectors.toggle) : xpath(`${itemPath(text)}//input[contains(@class,'toggle')]`);
      case 'filter': return q(selectors[name]);
      case 'delete': return hovered === undefined ? q(selectors.delete) : xpath(`${itemPath(hovered)}//button[@class='destroy']`);
      default: return q(selectors[kind]);
    }
  };
  const lines = scenario.steps.flatMap(([action, name, value]) => {
    switch (action) {
      case 'add': return [`await browser.setValue(${q(selectors.new)}, [${q(name)}, browser.Keys.ENTER]);`];
      // setValue() clears with WebDriver's Element Clear, which blurs the field: blur ends
      // TodoMVC's edit mode, so the edit field is replaced the way a user does it.
      case 'fill': return name === 'edit'
        ? [`await browser.sendKeys(${element(name)}, [browser.Keys.CONTROL, 'a', browser.Keys.NULL, ${value ? q(value) : 'browser.Keys.BACK_SPACE'}]);`]
        : [`await browser.setValue(${element(name)}, ${q(value)});`];
      case 'press': return [`await browser.sendKeys(${element(name)}, browser.Keys.${value === 'Enter' ? 'ENTER' : 'ESCAPE'});`];
      case 'click': return [`await browser.click(${element(name)});`];
      case 'dblclick': return [`await browser.doubleClick(${element(name)});`];
      case 'hover': {
        const { text } = parseTarget(name);
        hovered = text;
        return [`await browser.moveToElement(${text === undefined ? q(selectors.item) : xpath(itemPath(text))}, 10, 10);`];
      }
      case 'visible': return parseTarget(name).kind === 'counter'
        ? [`await browser.expect.element(${element(name)}).text.to.equal(${q(parseTarget(name).text)});`]
        : [`await browser.expect.element(${element(name)}).to.be.visible;`];
      // Every hidden target in the suite leaves the DOM; Nightwatch's visible assertion fails on a
      // missing element, so "not present" is its way to say it.
      case 'hidden': return [`await browser.expect.element(${element(name)}).to.not.be.present;`];
      case 'value': return [`await browser.expect.element(${element(name)}).to.have.value.that.equals(${q(value)});`];
      case 'checked': return [`await browser.expect.element(${element(name)}).to.be.selected;`];
      case 'unchecked': return [`await browser.expect.element(${element(name)}).to.not.be.selected;`];
      case 'focused': return [`await browser.expect.element(${element(name)}).to.be.active;`];
      case 'count': return [`await browser.expect.elements(${q(selectors.item)}).count.to.equal(${name});`];
      case 'items': return [
        `await browser.expect.elements(${q(selectors.item)}).count.to.equal(${name.length});`,
        ...name.map((text, index) => `await browser.expect.element(${q(`.todo-list li:nth-child(${index + 1}) label`)}).text.to.equal(${q(text)});`),
      ];
      case 'url': return [`await browser.expect.url().to.contain(${q(name)});`];
      default: throw new Error(`Unknown step ${action}`);
    }
  });
  return `  it(${q(scenario.title)}, async function (browser) {
${lines.map(line => `    ${line}\n`).join('')}  });
`;
}

// One test file per `file`, with its scenarios in order. Nightwatch runs a file as one suite in
// one browser session, so a file holds a single describe block. Tests that share the session start
// from empty storage: navigate, clear (the previous page may save todos as it unloads), reload.
function emitFile(file, scenarios) {
  const describes = new Set(scenarios.map(scenario => scenario.describe ?? 'Seed'));
  if (describes.size !== 1)
    throw new Error(`${file}: Nightwatch files hold one describe block, got ${[...describes].join(', ')}`);
  return `describe(${q([...describes][0])}, function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);${scenarios.length > 1 ? `
    browser.execute(function () {
      localStorage.clear();
    });
    browser.refresh();` : ''}
  });

  after(function (browser) {
    browser.end();
  });

${scenarios.map(emitTest).join('\n')}});
`;
}

function testFiles(scenarios) {
  const files = new Map();
  for (const scenario of scenarios)
    files.set(scenario.file, [...(files.get(scenario.file) ?? []), scenario]);
  return [...files].map(([file, fileScenarios]) => ({ path: `tests/${file}.js`, contents: emitFile(file, fileScenarios) }));
}

const config = `const workers = Number(process.env.WORKERS);

module.exports = {
  src_folders: ['tests'],
  output_folder: false,
  usage_analytics: { enabled: false },
  disable_output_boxes: true,
  detailed_output: false,
  test_workers: workers > 1 ? { enabled: true, workers } : false,
  webdriver: {
    start_process: true,
    server_path: process.env.CHROMEDRIVER_PATH,
    log_path: false,
  },
  test_settings: {
    default: {
      screenshots: { enabled: false },
      desiredCapabilities: {
        browserName: 'chrome',
        'goog:chromeOptions': {
          binary: process.env.CHROME_PATH,
          args: ['--headless=new', '--window-size=1280,720'],
        },
      },
      globals: { waitForConditionTimeout: 5000 },
    },
  },
};
`;

export default {
  label: 'Nightwatch',
  package: 'nightwatch',
  kind: 'test framework',
  files: scenarios => [
    ...testFiles(scenarios),
    { path: 'nightwatch.conf.js', contents: config },
  ],
  command: ({ node }) => ({ command: node, args: ['node_modules/nightwatch/bin/nightwatch'], env: {} }),
  // Nightwatch's summary counts assertions; each passed test prints a "✔ [Suite] title" line
  // ("✔ default [Suite] title" with test workers).
  passed: output => (output.match(/^\s*✔ (?:default )?\[.*\] /gm) ?? []).length,
};
