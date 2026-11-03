// Cypress port of the scenarios: one spec file per test, commands chained with retrying should().
import { join } from 'node:path';
import { parseTarget, selectors } from '../scenarios.mjs';

const exact = text => `/^${text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$/`;
// type() reads {...} as special keys; a literal brace is written {{}.
const keys = text => text.replace(/{/g, '{{}');
const typed = text => JSON.stringify(keys(text));
const get = selector => `cy.get(${JSON.stringify(selector)})`;
const todo = text => `cy.contains(${JSON.stringify(selectors.todoTitle)}, ${exact(text)})`;
const item = text => text === undefined ? get(selectors.item) : `cy.contains(${JSON.stringify(selectors.item)}, ${exact(text)})`;

function emitTest(scenario) {
  let hovered;
  const target = name => {
    const { kind, text } = parseTarget(name);
    switch (kind) {
      case 'todo': return todo(text);
      case 'toggle': return text === undefined ? get(selectors.toggle) : `${item(text)}.find('.toggle')`;
      case 'filter': return get(selectors[name]);
      case 'delete': return `${hovered}.find('.destroy')`;
      default: return get(selectors[kind]);
    }
  };
  const lines = scenario.steps.flatMap(([action, name, value]) => {
    switch (action) {
      case 'add': return [`${get(selectors.new)}.type(${JSON.stringify(`${keys(name)}{enter}`)});`];
      case 'fill': return [value ? `${target(name)}.clear().type(${typed(value)});` : `${target(name)}.clear();`];
      case 'press': return [`${target(name)}.type(${JSON.stringify(value === 'Enter' ? '{enter}' : '{esc}')});`];
      case 'click': return parseTarget(name).kind === 'delete'
        ? [`${target(name)}.click({ force: true });`]
        : [`${target(name)}.click();`];
      case 'dblclick': return [`${target(name)}.dblclick();`];
      case 'hover':
        hovered = item(parseTarget(name).text);
        return ['// Cypress has no hover: the delete button only shows on :hover, so it is checked to exist and clicked with { force: true }.'];
      case 'visible':
        if (parseTarget(name).kind === 'counter')
          return [`${target(name)}.should('have.text', ${JSON.stringify(parseTarget(name).text)});`];
        return [`${target(name)}.should(${JSON.stringify(parseTarget(name).kind === 'delete' ? 'exist' : 'be.visible')});`];
      // The app removes hidden todos from the DOM; Cypress's not.be.visible needs an element, so absence is not.exist.
      case 'hidden': return [`${target(name)}.should('not.exist');`];
      case 'value': return [`${target(name)}.should('have.value', ${JSON.stringify(value)});`];
      case 'checked': return [`${target(name)}.should('be.checked');`];
      case 'unchecked': return [`${target(name)}.should('not.be.checked');`];
      case 'focused': return [`${target(name)}.should('have.focus');`];
      case 'count': return [`${get(selectors.item)}.should('have.length', ${name});`];
      case 'items': return [`${get(selectors.todoTitle)}.should($titles => {\n      expect([...$titles].map(title => title.textContent)).to.deep.equal(${JSON.stringify(name)});\n    });`];
      case 'url': return [`cy.url().should('match', /${name.replace(/[/#]/g, '\\$&')}$/);`];
      default: throw new Error(`Unknown step ${action}`);
    }
  });
  return `it(${JSON.stringify(scenario.title)}, () => {\n${lines.map(line => `    ${line}\n`).join('')}  });`;
}

// One spec file per distinct `file`; its tests stay in scenario order, consecutive tests with the
// same describe share one describe block. testIsolation clears storage before every test.
function emitFile(scenarios) {
  const blocks = [];
  for (const scenario of scenarios) {
    const last = blocks.at(-1);
    if (last && last.describe === scenario.describe)
      last.tests.push(scenario);
    else
      blocks.push({ describe: scenario.describe, tests: [scenario] });
  }
  const parts = blocks.map(({ describe, tests }) => {
    const bodies = tests.map(emitTest);
    return describe
      ? `describe(${JSON.stringify(describe)}, () => {\n${bodies.map(body => `  ${body}\n`).join('\n')}});\n`
      : bodies.map(body => `${body.replace(/^ {2}/gm, '')}\n`).join('\n');
  });
  return `beforeEach(() => {\n  cy.visit(Cypress.expose('APP_URL'));\n});\n\n${parts.join('\n')}`;
}

function groupByFile(scenarios) {
  const files = new Map();
  for (const scenario of scenarios)
    files.set(scenario.file, [...files.get(scenario.file) ?? [], scenario]);
  return files;
}

export default {
  label: 'Cypress',
  package: 'cypress',
  kind: 'test framework',
  // Cypress runs specs one after another; parallel runs need Cypress Cloud.
  maxWorkers: 1,
  files: scenarios => [
    ...[...groupByFile(scenarios)].map(([file, tests]) => ({ path: `tests/${file}.cy.js`, contents: emitFile(tests) })),
    { path: 'cypress.config.js', contents: `const { defineConfig } = require('cypress');

module.exports = defineConfig({
  video: false,
  screenshotOnRunFailure: false,
  retries: 0,
  viewportWidth: 1280,
  viewportHeight: 720,
  // type() waits 10 ms after each keystroke by default; 0 types as fast as Cypress can.
  keystrokeDelay: 0,
  reporter: 'dot',
  e2e: {
    specPattern: 'tests/**/*.cy.js',
    supportFile: false,
    expose: { APP_URL: process.env.APP_URL },
  },
});
` },
  ],
  command: ({ node, env }) => ({
    command: node,
    args: ['node_modules/cypress/bin/cypress', 'run', '--browser', env.CHROME_PATH, '--headless'],
    env: {
      CYPRESS_CACHE_FOLDER: join(import.meta.dirname, 'node_modules/.cypress-cache'),
      CYPRESS_CRASH_REPORTS: '0',
      CYPRESS_COMMERCIAL_RECOMMENDATIONS: '0',
    },
  }),
  // The dot reporter prints "<n> passing" once per spec file.
  passed: output => [...output.matchAll(/(\d+) passing/g)].reduce((sum, match) => sum + Number(match[1]), 0),
};
