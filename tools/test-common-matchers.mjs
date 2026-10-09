import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { matchers } = require('../packages/flashwright-runner/dist/commonjs/matchers.js');
const { Locator } = require('../packages/flashwright-core/dist/commonjs/index.js');
const { iso } = require('playwright-core/lib/coreBundle');
const output = resolve(process.argv[2]);
await mkdir(output);
const report = { status: 'running', checks: [], comparisons: 0 };
const names = ['toHaveClass', 'toContainClass', 'toHaveCSS', 'toHaveId', 'toHaveValues', 'toHaveRole', 'toHaveAccessibleName', 'toHaveAccessibleDescription', 'toHaveAccessibleErrorMessage'];
const clean = value => JSON.parse(JSON.stringify(value));

/** Run exact pinned public-wrapper bodies with only the assertion transport replaced. */
function referenceMatchers(source) {
  const functions = names.map(name => {
    const beginning = source.indexOf(`function ${name}(`);
    const ending = source.indexOf('\nfunction ', beginning + 1);
    assert(beginning !== -1 && ending > beginning);
    return source.slice(beginning, ending);
  });
  const dispatch = function(_name, _actual, _type, callback, _expected, options) {
    return callback(this.isNot, options?.timeout ?? this.timeout);
  };
  return vm.runInNewContext(`${functions.join('\n')}\n({${names.join(',')}})`, {
    serializeExpectedTextValues: iso.serializeExpectedTextValues,
    toMatchText: dispatch, toEqual: dispatch,
    isRegExp2: value => value instanceof RegExp,
    isString2: value => typeof value === 'string',
  }, { timeout: 1000 });
}

function fixture(isNot = false) {
  const calls = [];
  const actual = Object.create(Locator.prototype);
  actual.toString = () => 'locator("controlled")';
  actual.runAssertion = async (request, timeout) => {
    calls.push(clean({ ...request, timeout }));
    return { observed: true, matches: !isNot, received: 'value', missingReceived: false, timedOut: false, diagnosticTruncated: false };
  };
  const reference = { _expect: async (expression, request) => calls.push(clean({ expression, ...request })) };
  const state = { isNot, timeout: 345, promise: '', utils: { matcherHint: name => name, printExpected: String, printReceived: String } };
  return { calls, actual, reference, state };
}

async function check(name, callback) { await callback(); report.checks.push(name); }
try {
  const source = await readFile('node_modules/playwright/lib/matchers/expect.js', 'utf8');
  report.pinnedSourceSha256 = createHash('sha256').update(source).digest('hex');
  const reference = referenceMatchers(source);
  const cases = [
    ['toHaveClass', ['first second']], ['toHaveClass', [/first\s+second/gi]], ['toHaveClass', [Object.freeze(['first', /second/u])]], ['toHaveClass', [[]]],
    ['toContainClass', ['second first']], ['toContainClass', [Object.freeze(['first', 'second'])]], ['toContainClass', [[]]],
    ['toHaveCSS', ['color', 'rgb(1, 2, 3)']], ['toHaveCSS', ['content', /generated/, { pseudo: 'before', timeout: 0 }]], ['toHaveCSS', ['display', 'block', { pseudo: 'after' }]],
    ['toHaveId', ['identifier']], ['toHaveId', [/ident/i]],
    ['toHaveValues', [Object.freeze(['one', /two/u])]], ['toHaveValues', [[]]],
    ['toHaveRole', ['button']],
    ...['toHaveAccessibleName', 'toHaveAccessibleDescription', 'toHaveAccessibleErrorMessage'].flatMap(name => [
      [name, [' normalized text ']], [name, [/UPPER/i, { ignoreCase: false, timeout: 19 }]], [name, [/lower/, { ignoreCase: true }]],
    ]),
  ];
  await check('new wrappers preserve pinned expression/text/pseudo/timeout/negation dispatch', async () => {
    for (const isNot of [false, true]) for (const [name, arguments_] of cases) {
      const state = fixture(isNot);
      await reference[name].call(state.state, state.reference, ...arguments_);
      await matchers[name].call(state.state, state.actual, ...arguments_);
      assert.deepEqual(state.calls[1], state.calls[0], `${name} isNot=${isNot}`);
      report.comparisons++;
    }
  });
  await check('invalid text/cardinality/pseudo/role inputs fail before native dispatch', async () => {
    const invalid = [
      ['toContainClass', [/invalid/]], ['toContainClass', [['valid', /invalid/]]],
      ['toHaveClass', [12]], ['toHaveClass', [['valid', null]]],
      ['toHaveCSS', ['color', ['red']]], ['toHaveCSS', [12, 'red']], ['toHaveCSS', ['color', 'red', { pseudo: 'marker' }]],
      ['toHaveId', [['identifier']]], ['toHaveValues', ['one']], ['toHaveValues', [[null]]],
      ['toHaveRole', [/button/]], ['toHaveAccessibleName', ['name', { ignoreCase: 'yes' }]],
      ['toHaveAccessibleDescription', [null]], ['toHaveAccessibleErrorMessage', [['message']]],
    ];
    for (const [name, arguments_] of invalid) {
      const state = fixture();
      await assert.rejects(matchers[name].call(state.state, state.actual, ...arguments_), error => error.name === 'InvalidArgumentError', name);
      assert.equal(state.calls.length, 0);
    }
  });
  await check('unsupported options and foreign objects reject without reaching assertion transport', async () => {
    for (const name of names) {
      const state = fixture();
      const arguments_ = name === 'toHaveCSS' ? ['color', 'red'] : name === 'toHaveValues' ? [['value']] : ['value'];
      await assert.rejects(matchers[name].call(state.state, state.actual, ...arguments_, { unsupported: true }), error => error.name === 'UnsupportedFeatureError');
      await assert.rejects(matchers[name].call(state.state, {}, ...arguments_), error => error.name === 'InvalidArgumentError');
      assert.equal(state.calls.length, 0);
    }
  });
  await check('timeout diagnostics preserve missing observations and bounded received values', async () => {
    const state = fixture(true);
    state.actual.runAssertion = async () => ({ observed: true, matches: true, received: 'bounded', missingReceived: false, timedOut: true, diagnosticTruncated: true });
    const result = await matchers.toHaveClass.call(state.state, state.actual, 'expected');
    assert.equal(result.pass, true);
    assert.equal(result.timeout, 345);
    assert.equal(result.actual, 'bounded');
    assert.match(result.message(), /diagnostic was truncated/);
    state.actual.runAssertion = async () => ({ observed: true, matches: false, missingReceived: true, timedOut: true, diagnosticTruncated: false });
    assert.match((await matchers.toHaveId.call(state.state, state.actual, 'expected')).message(), /no matching element/);
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report)); }
