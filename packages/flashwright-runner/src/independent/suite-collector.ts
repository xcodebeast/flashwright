import { AsyncLocalStorage } from 'node:async_hooks';
import { FixtureConfigurationError, FixturePool, type FixtureCallback, type FixtureValues } from './fixture-pool.js';
import { currentFiniteTestInfo, type FiniteTestInfo } from './suite-runtime.js';
import { timeoutValue } from './deadlines.js';

export type HookType = 'beforeAll' | 'beforeEach' | 'afterEach' | 'afterAll';
export type ExpectedStatus = 'passed' | 'failed' | 'skipped';
export type SuiteMode = 'inherit' | 'default' | 'parallel';
export interface SuiteHook { readonly type: HookType; readonly callback: FixtureCallback }
export interface PlannedSuite {
  readonly title: string;
  readonly hooks: readonly SuiteHook[];
  readonly mode: SuiteMode;
}
export interface PlannedTest {
  readonly id: string;
  readonly file: string;
  readonly title: string;
  readonly titlePath: readonly string[];
  readonly suites: readonly PlannedSuite[];
  readonly pool: FixturePool;
  readonly callback: FixtureCallback;
  readonly expectedStatus: ExpectedStatus;
  readonly timeout: number | undefined;
  readonly slow: boolean;
}
interface TestDeclaration {
  kind: 'test'; title: string; callback: FixtureCallback; pool: FixturePool; expectedStatus: ExpectedStatus;
}
interface SuiteDeclaration {
  kind: 'suite'; title: string; hooks: SuiteHook[]; use: FixtureValues[];
  entries: (SuiteDeclaration | TestDeclaration)[]; skipped: boolean; mode: SuiteMode;
  parent: SuiteDeclaration | undefined;
  timeout: number | undefined;
  slow: boolean;
}
interface CollectionSession { file: string; open: boolean; failed: boolean }
interface CollectionScope { session: CollectionSession; suite: SuiteDeclaration; open: boolean }
type DeclareTest = (title: string, callback: FixtureCallback) => void;
interface Describe {
  (title: string, body: () => void): void;
  skip(title: string, body: () => void): void;
  parallel(title: string, body: () => void): void;
  configure(options: { mode?: 'default' | 'parallel'; timeout?: number }): void;
}
export interface DeclarationTest extends DeclareTest {
  extend(definitions: FixtureValues): DeclarationTest;
  use(values: FixtureValues): void;
  describe: Describe;
  skip: DeclareTest;
  fail: DeclareTest;
  setTimeout(timeout: number): void;
  slow(condition?: boolean, description?: string): void;
  info(): FiniteTestInfo;
  beforeAll(callback: FixtureCallback): void;
  beforeEach(callback: FixtureCallback): void;
  afterEach(callback: FixtureCallback): void;
  afterAll(callback: FixtureCallback): void;
}
const hookTypes: readonly HookType[] = ['beforeAll', 'beforeEach', 'afterEach', 'afterAll'];
const newSuite = (title: string, skipped = false, parent?: SuiteDeclaration): SuiteDeclaration => ({ kind: 'suite', title, hooks: [], use: [], entries: [], skipped, mode: 'inherit', parent, timeout: undefined, slow: false });
const error = (message: string): never => { throw new FixtureConfigurationError(message); };

/** Collection sessions own their async imports. A late declaration from an old
 * file must never attach itself to a subsequently imported file. */
export class SuiteCollector {
  readonly #scope = new AsyncLocalStorage<CollectionScope>();
  readonly #files: { file: string; root: SuiteDeclaration; session: CollectionSession }[] = [];
  #collecting = false;
  #sealed: readonly PlannedTest[] | undefined;

  createTest(pool = new FixturePool()): DeclarationTest {
    const declare = (expectedStatus: ExpectedStatus): DeclareTest => (title, callback) => {
      const suite = this.current();
      if (typeof title !== 'string' || typeof callback !== 'function') error('Test requires a title and callback; runtime modifiers and test details are not implemented');
      suite.entries.push({ kind: 'test', title, callback, pool, expectedStatus });
    };
    const test = declare('passed') as DeclarationTest;
    test.extend = definitions => this.createTest(pool.extend(definitions));
    test.use = values => {
      const suite = this.current();
      if (!values || typeof values !== 'object' || Array.isArray(values)) error('test.use requires a fixture map');
      suite.use.push(Object.freeze({ ...values }));
    };
    test.skip = declare('skipped'); test.fail = declare('failed');
    test.info = currentFiniteTestInfo;
    test.setTimeout = timeout => {
      timeoutValue(timeout);
      if (this.#scope.getStore()) this.current().timeout = timeout;
      else currentFiniteTestInfo().setTimeout(timeout);
    };
    test.slow = (condition = true) => {
      if (typeof condition !== 'boolean') error('Fixture-dependent slow modifiers are not implemented');
      if (this.#scope.getStore()) { if (condition) this.current().slow = true; }
      else currentFiniteTestInfo().slow(condition);
    };
    const describe = ((title: string, body: () => void) => this.describe(title, body, false)) as Describe;
    describe.skip = (title, body) => this.describe(title, body, true);
    describe.parallel = (title, body) => this.describe(title, body, false, 'parallel');
    describe.configure = options => {
      const suite = this.current();
      if (!options || !Object.keys(options).length || Object.keys(options).some(key => !['mode', 'timeout'].includes(key))) error('Independent suite collection supports only mode and timeout configuration');
      if (options.mode !== undefined) {
        if (!['default', 'parallel'].includes(options.mode)) error('Independent suite collection does not implement serial grouping');
        if (suite.mode !== 'inherit') error('Suite mode is already assigned');
        this.setMode(suite, options.mode);
      }
      if (options.timeout !== undefined) suite.timeout = timeoutValue(options.timeout);
    };
    test.describe = describe;
    for (const type of hookTypes) test[type] = callback => {
      const suite = this.current();
      if (typeof callback !== 'function') error(`${type} requires a callback`);
      suite.hooks.push(Object.freeze({ type, callback }));
    };
    // Unsupported public spellings fail during collection, before fixture work.
    for (const name of ['only', 'fixme', 'step']) Object.defineProperty(test, name, { value: () => error(`test.${name} is not implemented by the independent suite core`) });
    for (const name of ['only', 'serial', 'fixme']) Object.defineProperty(describe, name, { value: () => error(`describe.${name} is not implemented by the independent suite core`) });
    return test;
  }

  async collect(file: string, load: () => unknown): Promise<void> {
    if (this.#sealed || this.#collecting) error('Suite collection is sealed or another file is being collected');
    if (this.#files.some(entry => entry.file === file)) error(`File was already collected: ${file}`);
    this.#collecting = true;
    const root = newSuite(''), session: CollectionSession = { file, open: true, failed: false };
    this.#files.push({ file, root, session });
    const scope: CollectionScope = { session, suite: root, open: true };
    try { await this.#scope.run(scope, load); }
    catch (cause) { session.failed = true; throw cause; }
    finally { session.open = false; scope.open = false; this.#collecting = false; }
  }

  seal(): readonly PlannedTest[] {
    if (this.#collecting) error('Cannot seal while a file is being collected');
    if (this.#files.some(entry => entry.session.failed)) error('Cannot execute an incomplete suite collection');
    if (this.#sealed) return this.#sealed;
    const tests: PlannedTest[] = [], identities = new Set<string>();
    for (const { file, root } of this.#files) {
      const visit = (suite: SuiteDeclaration, ancestors: readonly SuiteDeclaration[], plannedAncestors: readonly PlannedSuite[], skipped: boolean): void => {
        const lineage = [...ancestors, suite];
        const planned = [...plannedAncestors, Object.freeze({ title: suite.title, mode: suite.mode, hooks: Object.freeze([...suite.hooks]) })];
        for (const entry of suite.entries) {
          if (entry.kind === 'suite') { visit(entry, lineage, planned, skipped || suite.skipped); continue; }
          let pool = entry.pool;
          for (let i = 0; i < lineage.length; i++) {
            const parent = lineage[i]!;
            for (const use of parent.use) pool = pool.withUse(use, { inDescribe: i > 0 });
            for (const hook of parent.hooks) pool.required(hook.callback);
          }
          pool.required(entry.callback);
          const titlePath = Object.freeze([...lineage.slice(1).map(s => s.title), entry.title]);
          const id = JSON.stringify([file, ...titlePath]);
          if (identities.has(id)) error(`Duplicate test title: ${titlePath.join(' › ')}`);
          identities.add(id);
          tests.push(Object.freeze({ id, file, title: entry.title, titlePath, suites: Object.freeze(planned), pool, callback: entry.callback, expectedStatus: skipped || suite.skipped ? 'skipped' : entry.expectedStatus, timeout: [...lineage].reverse().find(s => s.timeout !== undefined)?.timeout, slow: lineage.some(s => s.slow) }));
        }
      };
      visit(root, [], [], false);
    }
    this.#sealed = Object.freeze(tests);
    return this.#sealed;
  }

  private current(): SuiteDeclaration {
    const scope = this.#scope.getStore();
    if (!scope || !scope.open || !scope.session.open || this.#sealed) error('Test declarations require an active file or synchronous describe callback');
    return scope!.suite;
  }
  private setMode(suite: SuiteDeclaration, mode: 'default' | 'parallel'): void {
    for (let parent = suite.parent; parent; parent = parent.parent) {
      if (mode === 'parallel' && parent.mode === 'default') error('Parallel suite cannot be nested inside an explicitly default suite');
    }
    suite.mode = mode;
  }
  private describe(title: string, body: () => void, skipped: boolean, mode?: 'parallel'): void {
    const parent = this.current(), owner = this.#scope.getStore()!;
    if (typeof title !== 'string' || typeof body !== 'function') error('describe requires a title and synchronous callback');
    const suite = newSuite(title, skipped, parent), scope = { session: owner.session, suite, open: true };
    if (mode) this.setMode(suite, mode);
    parent.entries.push(suite);
    try {
      const result: unknown = this.#scope.run(scope, body);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch(() => {});
        error('Async describe callbacks are not supported');
      }
    } catch (cause) { owner.session.failed = true; throw cause; }
    finally { scope.open = false; }
  }
}
