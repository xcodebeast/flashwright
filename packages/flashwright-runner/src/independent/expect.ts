import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Locator, Page, failure, type AriaSnapshotTemplate } from '@flashwright/core';
import type { Expect, ExpectMatcherState, MatcherReturnType } from 'flashwright-upstream-runner/test';
import { matchers as nativeMatchers } from '../matchers.js';

type Matcher = (this: ExpectMatcherState, actual: any, ...args: any[]) => MatcherReturnType | Promise<MatcherReturnType>;
type GenericNames = 'toBe' | 'toBeCloseTo' | 'toBeDefined' | 'toBeFalsy' | 'toBeGreaterThan' | 'toBeGreaterThanOrEqual' | 'toBeInstanceOf' | 'toBeLessThan' | 'toBeLessThanOrEqual' | 'toBeNaN' | 'toBeNull' | 'toBeTruthy' | 'toBeUndefined' | 'toContain' | 'toContainEqual' | 'toEqual' | 'toHaveLength' | 'toHaveProperty' | 'toMatch' | 'toMatchObject' | 'toStrictEqual' | 'toThrow' | 'toThrowError';
type GenericMatchers = Pick<ReturnType<Expect>, GenericNames>;
type UserMatchers<M, R> = { [K in keyof M]: M[K] extends (actual: any, ...args: infer A) => infer V ? (...args: A) => V extends PromiseLike<unknown> ? Promise<void> : R : never };
type AsyncGeneric<R> = { [K in keyof GenericMatchers]: GenericMatchers[K] extends (...args: infer A) => unknown ? (...args: A) => R : never };
type SupportedNative = typeof nativeMatchers & { toMatchAriaSnapshot: typeof toMatchAriaSnapshot };
type NativeFor<T> = { [K in keyof SupportedNative as T extends Parameters<SupportedNative[K]>[0] ? K : never]: SupportedNative[K] };
export type IndependentMatchers<T, M = {}, R = void> = AsyncGeneric<R> & UserMatchers<NativeFor<T>, R> & UserMatchers<M, R> & {
  not: IndependentMatchers<T, M, R>;
  resolves: IndependentMatchers<Awaited<T>, M, Promise<void>>;
  rejects: IndependentMatchers<any, M, Promise<void>>;
};
type AsymmetricNames = 'any' | 'anything' | 'arrayContaining' | 'arrayOf' | 'closeTo' | 'objectContaining' | 'stringContaining' | 'stringMatching';
export type IndependentExpect<M = {}> = Pick<Expect, AsymmetricNames> & UserMatchers<M, unknown> & {
  <T>(actual: T, messageOrOptions?: string | { message?: string }): IndependentMatchers<T, M>;
  extend<N extends Record<string, Matcher>>(matchers: N): IndependentExpect<M & N>;
  configure(options: { timeout?: number; message?: string }): IndependentExpect<M>;
  not: Expect['not'] & UserMatchers<M, unknown>;
};

const localRequire = createRequire(join(__dirname, 'expect.js'));
const library = localRequire('./expect-library.cjs') as Record<string, any>;
let defaultTimeout = 5000;
const unsupported = (name: string): never => { throw failure('UnsupportedFeatureError', `expect.${name}`, 'capability is not implemented by the independent runner'); };
function timeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw failure('InvalidArgumentError', 'expect.timeout', 'expected a finite nonnegative number');
  return value;
}
export function configureIndependentExpect(options: { timeout: number }): void {
  if (!options || Object.keys(options).some(key => key !== 'timeout')) throw failure('InvalidArgumentError', 'expect.configure', 'expected only timeout');
  defaultTimeout = timeout(options.timeout);
}

/** Inline baselines use the same pinned parser; baseline generation requires runner artifact ownership. */
async function toMatchAriaSnapshot(this: ExpectMatcherState, actual: Locator | Page, expected: string, options: { timeout?: number } = {}): Promise<MatcherReturnType> {
  if (!(actual instanceof Locator) && !(actual instanceof Page)) throw failure('InvalidArgumentError', 'expect.toMatchAriaSnapshot', 'expected a Flashwright Page or Locator');
  if (typeof expected !== 'string' || !expected.trim()) return unsupported('toMatchAriaSnapshot.baselineGeneration');
  if (expected.length > 100000) throw failure('ResourceLimitError', 'expect.toMatchAriaSnapshot', 'ARIA template exceeds 100000 UTF-16 units');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw failure('InvalidArgumentError', 'expect.toMatchAriaSnapshot', 'options must be an object');
  for (const key of Object.keys(options)) if (key !== 'timeout') unsupported(`toMatchAriaSnapshot.${key}`);
  const lines = expected.split('\n').filter(line => line.trim());
  const indent = Math.min(100, ...lines.map(line => /^\s*/.exec(line)![0].length));
  let template: AriaSnapshotTemplate;
  try {
    const parser = localRequire('./aria-parser.cjs') as { parseAriaSnapshotUnsafe(yaml: unknown, text: string): AriaSnapshotTemplate };
    template = parser.parseAriaSnapshotUnsafe(localRequire('./yaml.cjs'), lines.map(line => line.substring(indent)).join('\n'));
  } catch (error) { throw failure('InvalidArgumentError', 'expect.toMatchAriaSnapshot', error instanceof Error ? error.message : String(error)); }
  const budget = options.timeout === undefined ? this.timeout : timeout(options.timeout);
  const request = { expression: 'to.match.aria', expectedValue: template, isNot: this.isNot };
  const result = actual instanceof Locator ? await actual.runAssertion(request, budget) : await actual.mainFrame().runAssertion(null, request, budget);
  return { name: 'toMatchAriaSnapshot', pass: result.matches, expected, actual: result.received, message: () => [
    this.utils.matcherHint('toMatchAriaSnapshot', actual instanceof Locator ? actual.toString() : 'page', 'expected', { isNot: this.isNot, promise: this.promise }),
    ...(result.timedOut ? [`Timed out after ${budget}ms`] : []),
    `Expected${this.isNot ? ' not' : ''}: ${this.utils.printExpected(expected)}`,
    `Received: ${this.utils.printReceived(result.received)}`,
  ].join('\n') };
}

interface Configuration { timeout?: number; message?: string }
function createExpect(configuration: Configuration, custom: Record<string, Matcher>): IndependentExpect {
  const builtins: Record<string, Matcher> = { ...library.matchers, ...nativeMatchers, toMatchAriaSnapshot,
    toThrow: library.createThrowMatcher('toThrow'), toThrowError: library.createThrowMatcher('toThrowError') };
  const expectFn = (actual: unknown, messageOrOptions?: string | { message?: string }) => {
    const message = typeof messageOrOptions === 'string' ? messageOrOptions : messageOrOptions?.message ?? configuration.message;
    function create(isNot: boolean, promise: '' | 'resolves' | 'rejects'): object {
      return new Proxy({}, { get(_target, key) {
        if (key === 'not') return create(!isNot, promise);
        if (key === 'resolves' || key === 'rejects') return create(isNot, key);
        if (typeof key !== 'string') return undefined;
        const matcher = custom[key] ?? builtins[key];
        if (!matcher) return () => unsupported(key);
        return function assertMatcher(...args: unknown[]) {
          const state = { customTesters: [], equals: library.equals, isNot, promise, timeout: configuration.timeout ?? defaultTimeout, utils: library.utils };
          const stack = new Error();
          Error.captureStackTrace?.(stack, assertMatcher);
          function finalize(result: MatcherReturnType): void {
            library.validateMatcherResult(result);
            if (result.pass !== isNot) return;
            const diagnostic = typeof result.message === 'function' ? result.message() : result.message || 'No message was specified for this matcher.';
            const error = new Error(message ? `${message}\n\n${diagnostic}` : diagnostic) as Error & { matcherResult: unknown };
            error.matcherResult = { ...result, name: key, message: diagnostic };
            error.stack = `${error.name}: ${error.message}\n${stack.stack?.split('\n').slice(1).join('\n') ?? ''}`;
            throw error;
          }
          function invoke(value: unknown): MatcherReturnType | Promise<MatcherReturnType> {
            const selected = promise && (key === 'toThrow' || key === 'toThrowError') && !custom[key] ? library.createThrowMatcher(key, true) : matcher;
            return selected.call(state, value, ...args);
          }
          if (!promise) {
            const result = invoke(actual);
            return library.isPromise(result) ? Promise.resolve(result).then(finalize) : finalize(result as MatcherReturnType);
          }
          const value = typeof actual === 'function' ? actual() : actual;
          if (!library.isPromise(value)) return finalize({ pass: isNot, message: library.createExpectedPromiseMessage(key, isNot, promise, value) });
          return Promise.resolve(value).then(
            resolved => promise === 'resolves' ? invoke(resolved) : { pass: isNot, message: library.createExpectedToRejectMessage(key, isNot, promise, resolved) },
            rejected => promise === 'rejects' ? invoke(rejected) : { pass: isNot, message: library.createExpectedToResolveMessage(key, isNot, promise, rejected) },
          ).then(finalize);
        };
      } });
    }
    return create(false, '');
  };
  const asymmetric: Record<string, any> = {};
  for (const name of ['any', 'anything', 'arrayContaining', 'arrayOf', 'closeTo', 'objectContaining', 'stringContaining', 'stringMatching']) Object.assign(expectFn, { [name]: library[name] });
  for (const [name, source] of Object.entries({ arrayContaining: 'arrayNotContaining', arrayOf: 'notArrayOf', closeTo: 'notCloseTo', objectContaining: 'objectNotContaining', stringContaining: 'stringNotContaining', stringMatching: 'stringNotMatching' })) asymmetric[name] = library[source];
  const installCustom = (entries: Record<string, Matcher>) => {
    for (const [name, matcher] of Object.entries(entries)) {
      if (typeof matcher !== 'function') throw failure('InvalidArgumentError', `expect.extend.${name}`, 'expected a matcher function');
      const helpers = library.buildCustomAsymmetricMatcher(name, matcher);
      Object.assign(expectFn, { [name]: helpers.positive });
      asymmetric[name] = helpers.inverse;
    }
  };
  installCustom(custom);
  Object.assign(expectFn, {
    not: asymmetric,
    extend(entries: Record<string, Matcher>) { installCustom(entries); Object.assign(custom, entries); return createExpect(configuration, { ...custom }); },
    configure(options: Configuration) {
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw failure('InvalidArgumentError', 'expect.configure', 'expected an options object');
      for (const key of Object.keys(options)) if (key !== 'timeout' && key !== 'message') unsupported(`configure.${key}`);
      if (options.timeout !== undefined) timeout(options.timeout);
      if (options.message !== undefined && typeof options.message !== 'string') throw failure('InvalidArgumentError', 'expect.configure.message', 'expected a string');
      return createExpect({ ...configuration, ...options }, custom);
    },
    soft: () => unsupported('soft'), poll: () => unsupported('poll'),
  });
  return expectFn as IndependentExpect;
}
export const expect = createExpect({}, {});
