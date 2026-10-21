import { AsyncLocalStorage } from 'node:async_hooks';
import { FixtureConfigurationError, type FixturePool } from './fixture-pool.js';
import { FixtureWorker, type FixtureAttempt } from './fixture-runtime.js';
import type { ExpectedStatus, HookType, PlannedSuite, PlannedTest } from './suite-collector.js';

export type FailurePhase = HookType | 'body' | 'testTeardown' | 'workerTeardown';
export interface PhaseFailure { readonly phase: FailurePhase; readonly error: unknown }
export interface CallbackExecution { readonly phase: HookType | 'body'; readonly callback: Function; readonly finished: number }
export interface SuiteTestResult {
  readonly test: PlannedTest;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly expectedStatus: ExpectedStatus;
  readonly errors: readonly PhaseFailure[];
  readonly executions: readonly CallbackExecution[];
  readonly started: number;
  readonly finished: number;
}
export interface WorkerGroupResult {
  readonly workerStopped: boolean;
  readonly results: readonly SuiteTestResult[];
  readonly pending: readonly PlannedTest[];
  readonly failedBeforeAll: PlannedSuite | undefined;
  readonly teardownErrors: readonly PhaseFailure[];
}
export interface FiniteTestInfo {
  readonly testId: string; readonly title: string; readonly file: string;
  readonly retry: number; readonly workerIndex: number; readonly parallelIndex: number;
  readonly expectedStatus: ExpectedStatus;
  status: 'passed' | 'failed' | 'skipped';
}

interface ActiveTestContext { info: FiniteTestInfo; active: boolean }
interface WorkerTestContext { current: ActiveTestContext | undefined }
const executionContext = new AsyncLocalStorage<ActiveTestContext>();
const workerFixtureContext = new AsyncLocalStorage<WorkerTestContext>();
export function currentFiniteTestInfo(): FiniteTestInfo {
  // Worker fixtures belong to the worker across tests. Their teardown must see
  // the failing attempt, whereas detached test callbacks retain their origin.
  const owner = workerFixtureContext.getStore();
  const current = owner ? owner.current : executionContext.getStore();
  if (!current?.active) throw new FixtureConfigurationError('No active independent test attempt');
  return current.info;
}

export interface SuiteWorkerInfo { workerIndex: number; parallelIndex: number }
export interface SuiteRunOptions {
  retries?: ReadonlyMap<string, number>;
  onBegin?: (test: PlannedTest, info: FiniteTestInfo) => unknown;
  onResult?: (result: SuiteTestResult) => unknown;
}

/** A successful group closes its suites, while this owner keeps compatible
 * worker fixtures and imported module state alive until worker retirement. */
export class SuiteWorker {
  readonly #worker: FixtureWorker;
  readonly #info: SuiteWorkerInfo;
  readonly #context: WorkerTestContext = { current: undefined };
  #operation: Promise<WorkerGroupResult> | undefined;
  #closure: Promise<readonly PhaseFailure[]> | undefined;
  #stopped = false;
  constructor(pool: FixturePool, info: SuiteWorkerInfo = { workerIndex: 0, parallelIndex: 0 }) {
    this.#worker = new FixtureWorker(pool, info, callback => workerFixtureContext.run(this.#context, callback)); this.#info = info;
  }
  validate(tests: readonly PlannedTest[]): void {
    for (const test of tests) {
      this.#worker.validatePool(test.pool);
      test.pool.required(test.callback);
      for (const suite of test.suites) for (const hook of suite.hooks) test.pool.required(hook.callback);
    }
  }
  run(tests: readonly PlannedTest[], options: SuiteRunOptions = {}): Promise<WorkerGroupResult> {
    if (this.#operation || this.#closure || this.#stopped) return Promise.reject(new FixtureConfigurationError('Suite worker is busy or retired'));
    try { this.validate(tests); } catch (error) { return Promise.reject(error); }
    const operation = Promise.resolve().then(async () => {
      try {
        const result = await executeGroup(tests, this.#worker, this.#info, this.#context, options);
        this.#stopped = result.workerStopped;
        return result;
      } catch (error) {
        this.#stopped = true;
        throw error;
      }
    });
    this.#operation = operation;
    void operation.then(() => { this.#operation = undefined; }, () => { this.#operation = undefined; });
    return operation;
  }
  close(): Promise<readonly PhaseFailure[]> {
    if (!this.#closure) this.#closure = this.finish();
    return this.#closure;
  }
  private async finish(): Promise<readonly PhaseFailure[]> {
    await this.#operation?.catch(() => {});
    if (this.#stopped) return [];
    try { await this.#worker.close(); return []; }
    catch (cause) {
      const causes: unknown[] = cause instanceof AggregateError ? cause.errors : [cause];
      return Object.freeze(causes.map(error => Object.freeze({ phase: 'workerTeardown' as const, error })));
    }
  }
}

/** Convenience for a single finite group with its own worker lifetime. */
export async function runWorkerGroup(tests: readonly PlannedTest[], workerInfo?: SuiteWorkerInfo): Promise<WorkerGroupResult> {
  if (!tests.length) return { results: [], pending: [], failedBeforeAll: undefined, teardownErrors: [], workerStopped: false };
  const worker = new SuiteWorker(tests[0]!.pool, workerInfo);
  let result: WorkerGroupResult;
  try { result = await worker.run(tests); }
  catch (error) { await worker.close(); throw error; }
  const teardownErrors = await worker.close();
  return Object.freeze({ ...result, teardownErrors });
}

async function executeGroup(tests: readonly PlannedTest[], worker: FixtureWorker, workerInfo: SuiteWorkerInfo, owner: WorkerTestContext, options: SuiteRunOptions): Promise<WorkerGroupResult> {
  const results: SuiteTestResult[] = [];
  const active = new Set<PlannedSuite>();
  let failedBeforeAll: PlannedSuite | undefined, completed = 0;
  let workerStopped = false;
  let lastAttempt: { test: PlannedTest; info: FiniteTestInfo } | undefined;
  try {
    for (let index = 0; index < tests.length; index++) {
      const test = tests[index]!, errors: PhaseFailure[] = [], executions: CallbackExecution[] = [];
      const started = performance.now();
      const info: FiniteTestInfo = { testId: test.id, title: test.title, file: test.file, retry: options.retries?.get(test.id) ?? 0, ...workerInfo, expectedStatus: test.expectedStatus, status: test.expectedStatus === 'skipped' ? 'skipped' : 'passed' };
      await options.onBegin?.(test, info);
      lastAttempt = { test, info };
      const context = { info, active: true };
      owner.current = context;
      let stop = false;
      try { await executionContext.run(context, async () => {
        const record = (phase: FailurePhase, cause: unknown, cleanup = false): void => {
          const causes: unknown[] = cleanup && cause instanceof AggregateError ? cause.errors : [cause];
          for (const error of causes) errors.push({ phase, error });
          info.status = 'failed';
        };
        const unexpected = (): boolean => info.status !== 'skipped' && info.status !== info.expectedStatus;
        const allHooks = async (suite: PlannedSuite, type: 'beforeAll' | 'afterAll'): Promise<void> => {
          for (const hook of suite.hooks.filter(h => h.type === type)) {
            const scope = worker.beginAttempt(info, test.pool);
            try { if ((await scope.run(hook.callback, 'all-hooks-only')).ran) executions.push({ phase: type, callback: hook.callback, finished: performance.now() }); }
            catch (error) { record(type, error); }
            finally { try { await scope.close(); } catch (error) { record(type, error, true); } }
          }
        };
        const eachHooks = async (scope: FixtureAttempt, suites: readonly PlannedSuite[], type: 'beforeEach' | 'afterEach'): Promise<void> => {
          for (const suite of suites) for (const hook of suite.hooks.filter(h => h.type === type)) {
            try { if ((await scope.run(hook.callback)).ran) executions.push({ phase: type, callback: hook.callback, finished: performance.now() }); } catch (error) { record(type, error); }
          }
        };

        if (info.status !== 'skipped') {
          let beforeAllFailed = false;
          for (const suite of test.suites) {
            if (active.has(suite)) continue;
            active.add(suite);
            const before = errors.length;
            await allHooks(suite, 'beforeAll');
            if (errors.length !== before) { failedBeforeAll ??= suite; beforeAllFailed = true; break; }
          }
          if (!beforeAllFailed) {
            const scope = worker.beginAttempt(info, test.pool);
            try {
              await eachHooks(scope, test.suites, 'beforeEach');
              if (!errors.length) {
                try { if ((await scope.run(test.callback)).ran) executions.push({ phase: 'body', callback: test.callback, finished: performance.now() }); } catch (error) { record('body', error); }
              }
            } finally {
              await eachHooks(scope, [...test.suites].reverse(), 'afterEach');
              try { await scope.close(); } catch (error) { record('testTeardown', error, true); }
            }
          }
        }
        const next = tests[index + 1];
        for (const suite of [...active].reverse()) {
          if (unexpected() || !next?.suites.includes(suite)) {
            active.delete(suite);
            await allHooks(suite, 'afterAll');
          }
        }
        stop = unexpected();
        if (stop) {
          workerStopped = true;
          // Failure shutdown belongs to this test; normal shutdown errors below
          // are separate and cannot retroactively rewrite a successful result.
          try { await worker.close(); } catch (error) { record('workerTeardown', error, true); }
        }
      }); } finally { context.active = false; owner.current = undefined; }
      const result = Object.freeze({ test, status: info.status, expectedStatus: info.expectedStatus, errors: Object.freeze(errors), executions: Object.freeze(executions), started, finished: performance.now() });
      results.push(result);
      await options.onResult?.(result);
      completed++;
      if (stop) break;
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    const retain = (cause: unknown): void => {
      if (cause instanceof AggregateError) cleanupErrors.push(...cause.errors);
      else cleanupErrors.push(cause);
    };
    const cleanup = async (): Promise<void> => {
      for (const suite of [...active].reverse()) {
        active.delete(suite);
        for (const hook of suite.hooks.filter(h => h.type === 'afterAll')) {
          let scope: FixtureAttempt | undefined;
          try {
            scope = worker.beginAttempt(owner.current!.info, lastAttempt!.test.pool);
            await scope.run(hook.callback, 'all-hooks-only');
          } catch (cause) { cleanupErrors.push(cause); }
          finally { try { await scope?.close(); } catch (cause) { retain(cause); } }
        }
      }
      if (!workerStopped) {
        try { await worker.close(); } catch (cause) { retain(cause); }
      }
    };
    // Observer failures can arrive between attempts. Drain entered suites with
    // the last accepted attempt's pool, before retiring worker dependencies.
    // A fresh context keeps detached callbacks from that attempt expired.
    if (lastAttempt) {
      const context: ActiveTestContext = { info: { ...lastAttempt.info, status: 'failed' }, active: true };
      owner.current = context;
      try { await executionContext.run(context, cleanup); }
      finally { context.active = false; owner.current = undefined; }
    } else await cleanup();
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'Suite execution and cleanup failed');
    throw error;
  }
  return Object.freeze({ results: Object.freeze(results), pending: Object.freeze(tests.slice(completed)), failedBeforeAll, teardownErrors: Object.freeze([]), workerStopped });
}
