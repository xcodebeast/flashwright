import { Locator, Page, failure, type AssertionOptions, type ExpectedText } from 'flashwright';
import type { ExpectMatcherState, MatcherReturnType } from 'flashwright-upstream-runner/test';

export type Text = string | RegExp;
export interface TimeoutOptions { timeout?: number }
export interface TextOptions extends TimeoutOptions { ignoreCase?: boolean; useInnerText?: boolean }

function validate(method: string, options: object, supported: string[]): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw failure('InvalidArgumentError', method, 'options must be an object');
  for (const [key, value] of Object.entries(options)) {
    if (!supported.includes(key)) throw failure('UnsupportedFeatureError', `${method}.${key}`, 'assertion option is not implemented');
    if (value !== undefined && key !== 'timeout' && typeof value !== 'boolean') throw failure('InvalidArgumentError', `${method}.${key}`, 'expected a boolean');
  }
}
function texts(expected: Text | Text[], options: Pick<ExpectedText, 'normalizeWhiteSpace' | 'ignoreCase' | 'matchSubstring'>): ExpectedText[] {
  return (Array.isArray(expected) ? expected : [expected]).map(value => {
    if (typeof value === 'string') return { string: value, ...options };
    if (value instanceof RegExp) return { regexSource: value.source, regexFlags: value.flags, ...options };
    throw failure('InvalidArgumentError', 'expect', 'expected a string or regular expression');
  });
}
async function assertion(state: ExpectMatcherState, name: string, actual: Locator | Page, expected: unknown, options: TimeoutOptions, request: Omit<AssertionOptions, 'isNot'>): Promise<MatcherReturnType> {
  const isPageAssertion = ['to.have.title', 'to.have.url'].includes(request.expression);
  if (isPageAssertion ? !(actual instanceof Page) : !(actual instanceof Locator)) throw failure('InvalidArgumentError', name, `expected a Flashwright ${isPageAssertion ? 'Page' : 'Locator'}`);
  const timeout = options.timeout ?? state.timeout;
  const parameters = { ...request, isNot: state.isNot };
  const result = actual instanceof Locator ? await actual.runAssertion(parameters, timeout) : await actual.mainFrame().runAssertion(null, parameters, timeout);
  const target = actual instanceof Locator ? actual.toString() : 'page';
  const message = () => [
    state.utils.matcherHint(name, target, 'expected', { isNot: state.isNot, promise: state.promise }),
    ...(result.timedOut ? [`Timed out after ${timeout}ms`] : []),
    `Locator: ${target}`,
    `Expected${state.isNot ? ' not' : ''}: ${state.utils.printExpected(expected)}`,
    !result.observed ? 'Received: no observation before the deadline' : result.missingReceived ? 'Received: no matching element' : `Received: ${state.utils.printReceived(result.received)}`,
    ...(result.diagnosticTruncated ? ['Received diagnostic was truncated to its retention limit.'] : []),
  ].join('\n');
  return { name, pass: result.matches, expected, actual: result.received, message, ...(result.timedOut ? { timeout } : {}) };
}
function stateAssertion(state: ExpectMatcherState, name: string, actual: Locator, expression: string, options: TimeoutOptions, extra: Partial<AssertionOptions> = {}): Promise<MatcherReturnType> {
  return assertion(state, name, actual, expression.replace('to.be.', ''), options, { expression, ...extra });
}
function textAssertion(state: ExpectMatcherState, name: string, actual: Locator, expected: Text | Text[], options: TextOptions, contains: boolean): Promise<MatcherReturnType> {
  validate(name, options, ['timeout', 'ignoreCase', 'useInnerText']);
  const expression = Array.isArray(expected) ? contains ? 'to.contain.text.array' : 'to.have.text.array' : 'to.have.text';
  const expectedText = texts(expected, { normalizeWhiteSpace: true, matchSubstring: contains, ...(options.ignoreCase === undefined ? {} : { ignoreCase: options.ignoreCase }) });
  return assertion(state, name, actual, expected, options, { expression, expectedText, ...(options.useInnerText === undefined ? {} : { useInnerText: options.useInnerText }) });
}

export const matchers = {
  async toHaveText(this: ExpectMatcherState, actual: Locator, expected: Text | Text[], options: TextOptions = {}) { return textAssertion(this, 'toHaveText', actual, expected, options, false); },
  async toContainText(this: ExpectMatcherState, actual: Locator, expected: Text | Text[], options: TextOptions = {}) { return textAssertion(this, 'toContainText', actual, expected, options, true); },
  async toBeVisible(this: ExpectMatcherState, actual: Locator, options: TimeoutOptions & { visible?: boolean } = {}) { validate('toBeVisible', options, ['timeout', 'visible']); return stateAssertion(this, 'toBeVisible', actual, options.visible === false ? 'to.be.hidden' : 'to.be.visible', options); },
  async toBeHidden(this: ExpectMatcherState, actual: Locator, options: TimeoutOptions = {}) { validate('toBeHidden', options, ['timeout']); return stateAssertion(this, 'toBeHidden', actual, 'to.be.hidden', options); },
  async toBeEnabled(this: ExpectMatcherState, actual: Locator, options: TimeoutOptions & { enabled?: boolean } = {}) { validate('toBeEnabled', options, ['timeout', 'enabled']); return stateAssertion(this, 'toBeEnabled', actual, options.enabled === false ? 'to.be.disabled' : 'to.be.enabled', options); },
  async toBeDisabled(this: ExpectMatcherState, actual: Locator, options: TimeoutOptions = {}) { validate('toBeDisabled', options, ['timeout']); return stateAssertion(this, 'toBeDisabled', actual, 'to.be.disabled', options); },
  async toBeEditable(this: ExpectMatcherState, actual: Locator, options: TimeoutOptions & { editable?: boolean } = {}) { validate('toBeEditable', options, ['timeout', 'editable']); return stateAssertion(this, 'toBeEditable', actual, options.editable === false ? 'to.be.readonly' : 'to.be.editable', options); },
  async toBeAttached(this: ExpectMatcherState, actual: Locator, options: TimeoutOptions & { attached?: boolean } = {}) { validate('toBeAttached', options, ['timeout', 'attached']); return stateAssertion(this, 'toBeAttached', actual, options.attached === false ? 'to.be.detached' : 'to.be.attached', options); },
  async toBeEmpty(this: ExpectMatcherState, actual: Locator, options: TimeoutOptions = {}) { validate('toBeEmpty', options, ['timeout']); return stateAssertion(this, 'toBeEmpty', actual, 'to.be.empty', options); },
  async toBeFocused(this: ExpectMatcherState, actual: Locator, options: TimeoutOptions = {}) { validate('toBeFocused', options, ['timeout']); return stateAssertion(this, 'toBeFocused', actual, 'to.be.focused', options); },
  async toBeChecked(this: ExpectMatcherState, actual: Locator, options: TimeoutOptions & { checked?: boolean; indeterminate?: boolean } = {}) {
    validate('toBeChecked', options, ['timeout', 'checked', 'indeterminate']);
    if (options.indeterminate && options.checked !== undefined) throw failure('InvalidArgumentError', 'toBeChecked', 'checked and indeterminate cannot be asserted together');
    const { timeout: _timeout, ...expectedValue } = options;
    return stateAssertion(this, 'toBeChecked', actual, 'to.be.checked', options, { expectedValue });
  },
  async toHaveCount(this: ExpectMatcherState, actual: Locator, expected: number, options: TimeoutOptions = {}) {
    validate('toHaveCount', options, ['timeout']);
    if (typeof expected !== 'number' || !Number.isFinite(expected)) throw failure('InvalidArgumentError', 'toHaveCount', 'expected a finite number');
    return assertion(this, 'toHaveCount', actual, expected, options, { expression: 'to.have.count', expectedNumber: expected });
  },
  async toHaveValue(this: ExpectMatcherState, actual: Locator, expected: Text, options: TimeoutOptions = {}) { validate('toHaveValue', options, ['timeout']); return assertion(this, 'toHaveValue', actual, expected, options, { expression: 'to.have.value', expectedText: texts(expected, {}) }); },
  async toHaveTitle(this: ExpectMatcherState, actual: Page, expected: Text, options: TimeoutOptions = {}) { validate('toHaveTitle', options, ['timeout']); return assertion(this, 'toHaveTitle', actual, expected, options, { expression: 'to.have.title', expectedText: texts(expected, { normalizeWhiteSpace: true }) }); },
  async toHaveURL(this: ExpectMatcherState, actual: Page, expected: Text, options: TimeoutOptions & { ignoreCase?: boolean } = {}) {
    validate('toHaveURL', options, ['timeout', 'ignoreCase']);
    if (typeof expected === 'function') throw failure('UnsupportedFeatureError', 'toHaveURL', 'URL callback assertions are not implemented');
    let resolved = expected;
    if (typeof expected === 'string') { try { resolved = new URL(expected, actual.context().baseURL).href; } catch {} }
    return assertion(this, 'toHaveURL', actual, expected, options, { expression: 'to.have.url', expectedText: texts(resolved, options.ignoreCase === undefined ? {} : { ignoreCase: options.ignoreCase }) });
  },
  async toHaveAttribute(this: ExpectMatcherState, actual: Locator, name: string, expectedOrOptions?: Text | TimeoutOptions, options: TimeoutOptions & { ignoreCase?: boolean } = {}) {
    const expected = typeof expectedOrOptions === 'object' && !(expectedOrOptions instanceof RegExp) ? undefined : expectedOrOptions;
    if (expectedOrOptions !== undefined && expected === undefined) options = expectedOrOptions as TimeoutOptions;
    validate('toHaveAttribute', options, ['timeout', 'ignoreCase']);
    if (typeof name !== 'string') throw failure('InvalidArgumentError', 'toHaveAttribute', 'attribute name must be a string');
    return assertion(this, 'toHaveAttribute', actual, expected ?? 'attribute present', options, { expression: expected === undefined ? 'to.have.attribute' : 'to.have.attribute.value', expressionArg: name, ...(expected === undefined ? {} : { expectedText: texts(expected, options.ignoreCase === undefined ? {} : { ignoreCase: options.ignoreCase }) }) });
  },
};
