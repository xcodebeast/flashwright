import type { Fixtures } from 'flashwright-upstream-runner/test';
import { failure } from '@flashwright/core';
import { FixturePool, type FixtureCallback, type FixtureValues } from './independent/fixture-pool.js';
import { SuiteCollector, type DeclarationTest, type PlannedTest } from './independent/suite-collector.js';
import { nativeFixtures, type NativeTestFixtures, type NativeWorkerFixtures } from './independent/fixtures.js';
import { currentIndependentInfo, independentStep, type IndependentTestInfo } from './independent/output.js';
export { expect } from './independent/expect.js';
export { chromium, request, errors, devices } from '@flashwright/core';
export type { Browser, BrowserContext, Page, Locator, APIRequestContext } from '@flashwright/core';
export type { IndependentTestInfo } from './independent/output.js';

export interface IndependentTest<T extends object = NativeTestFixtures, W extends object = NativeWorkerFixtures> {
  (title: string, callback: (fixtures: T & W, info: IndependentTestInfo) => unknown): void;
  extend<A extends object, B extends object = object>(definitions: Fixtures<A, B, T, W>): IndependentTest<T & A, W & B>;
  use(values: Partial<T & W>): void;
  describe: DeclarationTest['describe'];
  skip(title: string, callback: (fixtures: T & W, info: IndependentTestInfo) => unknown): void;
  fail(title: string, callback: (fixtures: T & W, info: IndependentTestInfo) => unknown): void;
  beforeEach(callback: (fixtures: T & W, info: IndependentTestInfo) => unknown): void;
  afterEach(callback: (fixtures: T & W, info: IndependentTestInfo) => unknown): void;
  beforeAll(callback: (fixtures: T & W, info: IndependentTestInfo) => unknown): void;
  afterAll(callback: (fixtures: T & W, info: IndependentTestInfo) => unknown): void;
  setTimeout(timeout: number): void;
  slow(condition?: boolean, description?: string): void;
  info(): IndependentTestInfo;
  step<R>(title: string, callback: () => R | Promise<R>): Promise<R>;
}
let collector: SuiteCollector | undefined;
let rootTest: DeclarationTest | undefined;
function raw(): DeclarationTest {
  if (!rootTest) throw failure('InvalidArgumentError', 'independent.test', 'load tests using flashwright test --runner=independent');
  return rootTest;
}
function facade<T extends object, W extends object>(get: () => DeclarationTest): IndependentTest<T, W> {
  const api = ((title: string, callback: (fixtures: T & W, info: IndependentTestInfo) => unknown) => get()(title, callback as FixtureCallback)) as IndependentTest<T, W>;
  api.extend = definitions => {
    let extended: DeclarationTest | undefined;
    return facade(() => extended ??= get().extend(definitions as FixtureValues));
  };
  api.use = values => get().use(values as FixtureValues);
  for (const name of ['skip', 'fail', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll'] as const) {
    Object.defineProperty(api, name, { value: (...args: unknown[]) => Reflect.apply(get()[name], get(), args) });
  }
  const describe = ((title: string, callback: () => void) => get().describe(title, callback)) as DeclarationTest['describe'];
  describe.skip = (title, callback) => get().describe.skip(title, callback);
  describe.parallel = (title, callback) => get().describe.parallel(title, callback);
  describe.configure = options => get().describe.configure(options);
  for (const name of ['only','serial','fixme']) Object.defineProperty(describe, name, { value: () => { throw failure('UnsupportedFeatureError', `test.describe.${name}`, 'not integrated with the independent runner'); } });
  api.describe = describe;
  api.setTimeout = timeout => get().setTimeout(timeout);
  api.slow = (condition, description) => get().slow(condition, description);
  api.info = currentIndependentInfo;
  api.step = independentStep;
  for (const name of ['only','fixme']) Object.defineProperty(api, name, { value: () => { throw failure('UnsupportedFeatureError', `test.${name}`, 'not integrated with the independent runner'); } });
  return api;
}
export const test: IndependentTest = facade(raw);
export default test;
export function defineConfig<T extends object>(config: T): T { return config; }

/** Internal loader hooks share the canonical public declaration instance. */
export function initializeIndependentCollection(use: Record<string, unknown>): void {
  if (collector) throw new Error('Independent collection already initialized');
  collector = new SuiteCollector();
  rootTest = collector.createTest(new FixturePool(nativeFixtures as FixtureValues, { configurationUse: use }));
}
export async function collectIndependentFile(file: string, fullyParallel: boolean, load: () => unknown): Promise<void> {
  if (!collector) throw new Error('Independent collection is not initialized');
  await collector.collect(file, () => { if (fullyParallel) raw().describe.configure({ mode: 'parallel' }); load(); });
}
export function sealIndependentCollection(): readonly PlannedTest[] {
  if (!collector) throw new Error('Independent collection is not initialized');
  return collector.seal();
}
