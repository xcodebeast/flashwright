// TestCafe port of the scenarios: one fixture file per test, Selector properties in t.expect
// assertions, which TestCafe retries until they pass.
import { parseTarget, selectors } from '../scenarios.mjs';

const selector = css => `Selector(${JSON.stringify(css)})`;
const todo = text => `${selector(selectors.todoTitle)}.withExactText(${JSON.stringify(text)})`;
const item = text => text === undefined ? selector(selectors.item) : `${todo(text)}.parent('li')`;

function emitTest(scenario) {
  let hovered;
  let usesUrl = false;
  const target = name => {
    const { kind, text } = parseTarget(name);
    switch (kind) {
      case 'todo': return todo(text);
      case 'toggle': return text === undefined ? selector(selectors.toggle) : `${item(text)}.find('.toggle')`;
      case 'filter': return selector(selectors[name]);
      case 'delete': return `${hovered}.find('.destroy')`;
      default: return selector(selectors[kind]);
    }
  };
  const lines = scenario.steps.map(([action, name, value]) => {
    switch (action) {
      case 'add': return `await t.typeText(${selector(selectors.new)}, ${JSON.stringify(name)}).pressKey('enter');`;
      // typeText needs text; an empty value clears the field by selecting it and pressing Delete.
      case 'fill': return value
        ? `await t.typeText(${target(name)}, ${JSON.stringify(value)}, { replace: true });`
        : `await t.selectText(${target(name)}).pressKey('delete');`;
      case 'press': return `await t.pressKey(${JSON.stringify(value === 'Enter' ? 'enter' : 'esc')});`;
      case 'click': return `await t.click(${target(name)});`;
      case 'dblclick': return `await t.doubleClick(${target(name)});`;
      case 'hover': hovered = item(parseTarget(name).text); return `await t.hover(${hovered});`;
      case 'visible': return parseTarget(name).kind === 'counter'
        ? `await t.expect(${target(name)}.innerText).eql(${JSON.stringify(parseTarget(name).text)});`
        : `await t.expect(${target(name)}.visible).ok();`;
      // The app removes hidden todos from the DOM. `.visible` waits the whole selector timeout for
      // an element that never appears, so absence is asserted with `.exists`, which does not.
      case 'hidden': return `await t.expect(${target(name)}.exists).notOk();`;
      case 'value': return `await t.expect(${target(name)}.value).eql(${JSON.stringify(value)});`;
      case 'checked': return `await t.expect(${target(name)}.checked).ok();`;
      case 'unchecked': return `await t.expect(${target(name)}.checked).notOk();`;
      case 'focused': return `await t.expect(${target(name)}.focused).ok();`;
      case 'count': return `await t.expect(${selector(selectors.item)}.count).eql(${name});`;
      case 'items': return [
        `await t.expect(${selector(selectors.todoTitle)}.count).eql(${name.length});`,
        ...name.map((text, index) => `await t.expect(${selector(selectors.todoTitle)}.nth(${index}).innerText).eql(${JSON.stringify(text)});`),
      ].join('\n    ');
      case 'url': usesUrl = true; return `await t.expect(getLocation()).match(/${name.replace(/[/#]/g, '\\$&')}$/);`;
      default: throw new Error(`Unknown step ${action}`);
    }
  });
  return { usesUrl, code: `test(${JSON.stringify(scenario.title)}, async t => {\n${lines.map(line => `    ${line}\n`).join('')}});\n` };
}

// One file per distinct `file`; its tests stay in scenario order, consecutive tests with the same
// describe share one fixture. TestCafe starts every test with clean cookies and storage.
function emitFile(scenarios) {
  const fixtures = [];
  for (const scenario of scenarios) {
    const name = scenario.describe ?? scenario.title;
    const last = fixtures.at(-1);
    if (last && last.name === name)
      last.tests.push(emitTest(scenario));
    else
      fixtures.push({ name, tests: [emitTest(scenario)] });
  }
  const usesUrl = fixtures.some(fixture => fixture.tests.some(test => test.usesUrl));
  return `import { ${usesUrl ? 'ClientFunction, ' : ''}Selector } from 'testcafe';
${usesUrl ? '\nconst getLocation = ClientFunction(() => document.location.href);\n' : ''}
${fixtures.map(({ name, tests }) => `fixture(${JSON.stringify(name)})\n  .page(process.env.APP_URL);\n\n${tests.map(test => test.code).join('\n')}`).join('\n')}`;
}

function groupByFile(scenarios) {
  const files = new Map();
  for (const scenario of scenarios)
    files.set(scenario.file, [...files.get(scenario.file) ?? [], scenario]);
  return files;
}

export default {
  label: 'TestCafe',
  package: 'testcafe',
  kind: 'test framework',
  files: scenarios => [
    ...[...groupByFile(scenarios)].map(([file, tests]) => ({ path: `tests/${file}.test.js`, contents: emitFile(tests) })),
    { path: '.testcaferc.json', contents: `${JSON.stringify({
      src: ['tests/**/*.test.js'],
      reporter: 'spec',
      quarantineMode: false,
      skipJsErrors: false,
      screenshots: { takeOnFails: false },
      color: false,
    }, null, 2)}\n` },
  ],
  command: ({ node, workers, env }) => ({
    command: node,
    args: ['node_modules/testcafe/bin/testcafe-with-v8-flag-filter.js', `chromium:${env.CHROME_PATH}:headless`, '-c', String(workers)],
    env: {},
  }),
  passed: output => Number(/(\d+) passed/.exec(output)?.[1] ?? 0),
};
