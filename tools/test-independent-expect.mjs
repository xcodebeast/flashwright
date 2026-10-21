import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { Locator, Page } from '../packages/flashwright-core/dist/esm/index.js';

const require = createRequire(import.meta.url);
const { expect, configureIndependentExpect } = require(resolve(process.env.FLASHWRIGHT_EXPECT_MODULE ?? 'packages/flashwright-runner/dist/commonjs/independent/expect.js'));
const unsupported = error => error.name === 'UnsupportedFeatureError';
function target(kind = Locator) {
  const calls = [];
  const object = Object.create(kind.prototype);
  object.toString = () => 'locator("button")';
  const runAssertion = async (...args) => { calls.push(args); return { matches: true, observed: true, received: 'native result' }; };
  if (kind === Locator) object.runAssertion = runAssertion;
  else object.mainFrame = () => ({ runAssertion });
  return { object, calls };
}

test('generic equality, collection and asymmetric semantics use the pinned assertion library', () => {
  expect(NaN).toBe(NaN);
  assert.throws(() => expect(-0).toBe(0), /Object.is equality/);
  expect({ absent: undefined }).toEqual({});
  assert.throws(() => expect({ absent: undefined }).toStrictEqual({}), /toStrictEqual/);
  expect(new Set([{ id: 1 }])).toEqual(new Set([{ id: 1 }]));
  expect(new Map([['key', { id: 1 }]])).toEqual(new Map([['key', { id: 1 }]]));
  const cycle = {}; cycle.self = cycle;
  const other = {}; other.self = other;
  expect(cycle).toEqual(other);
  expect({ id: 2, name: 'Save' }).toEqual(expect.objectContaining({ id: expect.any(Number) }));
  expect(['Save', 'Close']).toEqual(expect.arrayOf(expect.any(String)));
  expect(['Save']).toEqual(expect.not.arrayContaining(['Close']));
  expect(0.1 + 0.2).toBeCloseTo(0.3);
  expect({ nested: { value: 2 } }).toHaveProperty('nested.value', 2);
  expect('Save changes').toMatch(/changes$/);
});

test('negation and throw matchers retain diagnostics and matcherResult', () => {
  expect(1).not.not.toBe(1);
  expect(() => { throw new TypeError('sentinel'); }).toThrow(TypeError);
  expect(() => {}).not.toThrow();
  assert.throws(() => expect(1, 'custom assertion title').toBe(2), error => {
    assert.match(error.message, /^custom assertion title\n\n/);
    assert.equal(error.matcherResult.name, 'toBe');
    assert.equal(error.matcherResult.actual, 1);
    assert.equal(error.matcherResult.expected, 2);
    assert.match(error.stack, /test-independent-expect.mjs/);
    return true;
  });
});

test('promises unwrap values and errors, including promised throw matchers', async () => {
  await expect(Promise.resolve({ id: 2 })).resolves.toEqual({ id: 2 });
  await expect(() => Promise.resolve(2)).resolves.not.toBe(1);
  await expect(Promise.reject(new Error('sentinel'))).rejects.toThrow('sentinel');
  await expect(Promise.reject(new TypeError('sentinel'))).rejects.toThrowError(TypeError);
  await assert.rejects(expect(Promise.resolve(2)).rejects.not.toBe(1), /resolved instead of rejected/);
  await assert.rejects(expect(Promise.reject('sentinel')).resolves.not.toBe(1), /rejected instead of resolved/);
  assert.throws(() => expect(2).resolves.not.toBe(1), /must be a promise/);
});

test('extensions receive equality/utilities and supply asymmetrics', async () => {
  const extended = expect.extend({
    toHaveToken(actual, token) {
      return { pass: this.equals(actual, { token }), message: () => this.utils.matcherHint('toHaveToken', 'received', 'token') };
    },
    async toResolveToken(actual, token) { return { pass: actual.token === token, message: () => 'token mismatch' }; },
  });
  extended({ token: 'save' }).toHaveToken('save');
  await extended({ token: 'save' }).toResolveToken('save');
  extended([{ token: 'save' }]).toEqual([extended.toHaveToken('save')]);
  extended({ token: 'close' }).toEqual(extended.not.toHaveToken('save'));
  assert.throws(() => extended({ token: 'close' }).toHaveToken('save'), /toHaveToken/);
  assert.throws(() => extended.extend({ broken: 3 }), /expected a matcher function/);
});

test('native wrappers forward defaults, explicit timeouts, options and negation', async () => {
  configureIndependentExpect({ timeout: 321 });
  const { object, calls } = target();
  await expect(object).toHaveText('Save', { ignoreCase: true, useInnerText: true });
  assert.equal(calls[0][1], 321);
  assert.equal(calls[0][0].expression, 'to.have.text');
  assert.equal(calls[0][0].useInnerText, true);
  assert.equal(calls[0][0].expectedText[0].ignoreCase, true);
  assert.equal(calls[0][0].includeAriaSnapshot, true);
  await expect.configure({ timeout: 654 })(object).toBeVisible({ timeout: 123 });
  assert.equal(calls[1][1], 123);
  object.runAssertion = async (...args) => { calls.push(args); return { matches: false, observed: true }; };
  await expect.configure({ timeout: 654 })(object).not.toBeVisible();
  assert.equal(calls[2][1], 654);
  assert.equal(calls[2][0].isNot, true);
  assert.equal(calls[2][0].expression, 'to.be.visible');
  configureIndependentExpect({ timeout: 5000 });
});

test('page wrappers keep native main-frame ownership and original failure details', async () => {
  const { object, calls } = target(Page);
  await expect(object).toHaveTitle('Page title');
  assert.equal(calls[0][0], null);
  assert.equal(calls[0][1].expression, 'to.have.title');
  const locator = target().object;
  locator.runAssertion = async () => ({ matches: false, observed: true, timedOut: true, received: 'Waiting' });
  await assert.rejects(expect(locator).toHaveText('Ready', { timeout: 23 }), error => {
    assert.match(error.message, /Timed out after 23ms/);
    assert.match(error.message, /Waiting/);
    assert.equal(error.matcherResult.timeout, 23);
    return true;
  });
});

test('inline ARIA uses pinned indentation, regex, children and property parsing', async () => {
  const { object, calls } = target();
  await expect(object).toMatchAriaSnapshot(`
    - /children: equal
    - button /Save.*/ [disabled]:
      - /description: "Save your changes"
  `, { timeout: 88 });
  assert.equal(calls[0][1], 88);
  const template = calls[0][0].expectedValue;
  assert.equal(template.containerMode, 'equal');
  assert.equal(template.children[0].role, 'button');
  assert.equal(template.children[0].disabled, true);
  assert.equal(template.children[0].name.pattern, 'Save.*');
  assert.equal(template.children[0].props.description.raw, 'Save your changes');
  await assert.rejects(expect(object).toMatchAriaSnapshot('- button [unsupported]'), error => error.name === 'InvalidArgumentError');
  assert.equal(calls.length, 1, 'invalid templates do not dispatch browser work');
});

test('unsupported semantics fail explicitly before browser work', async () => {
  const { object, calls } = target();
  for (const name of ['toHaveScreenshot', 'toHaveJSProperty', 'toMatchSnapshot', 'toPass']) assert.throws(() => expect(object)[name](), unsupported);
  for (const name of ['soft', 'poll']) assert.throws(() => expect[name](() => object), unsupported);
  assert.throws(() => expect.configure({ soft: true }), unsupported);
  await assert.rejects(expect(object).toMatchAriaSnapshot(), unsupported);
  await assert.rejects(expect(object).toMatchAriaSnapshot(''), unsupported);
  await assert.rejects(expect(object).toMatchAriaSnapshot('- button', { name: 'baseline' }), unsupported);
  await assert.rejects(expect(object).toHaveText('Save', { unsupported: true }), unsupported);
  assert.equal(calls.length, 0);
  for (const value of [-1, Infinity, NaN, '100']) assert.throws(() => configureIndependentExpect({ timeout: value }), error => error.name === 'InvalidArgumentError');
});

test('generic/native/ARIA imports never initialize upstream runner or browser machinery', () => {
  const forbidden = Object.keys(require.cache).filter(path => /(?:flashwright-upstream-runner|playwright-core|[/\\]dist[/\\]upstream)[/\\](?:lib[/\\](?:common|worker|runner|matchers|coreBundle|server|client)|test\.)/.test(path));
  assert.deepEqual(forbidden, []);
});
