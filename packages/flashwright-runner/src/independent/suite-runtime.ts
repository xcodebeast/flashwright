import { FixtureWorker, type FixtureAttempt } from './fixture-runtime.js';
import type { ExpectedStatus, HookType, PlannedSuite, PlannedTest } from './suite-collector.js';

export type FailurePhase = HookType | 'body' | 'testTeardown' | 'workerTeardown';
export interface PhaseFailure { readonly phase: FailurePhase; readonly error: unknown }
export interface SuiteTestResult {
  readonly test: PlannedTest;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly expectedStatus: ExpectedStatus;
  readonly errors: readonly PhaseFailure[];
}
export interface WorkerGroupResult {
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

/** Executes one already grouped, ordered set of finite tests. Process restart,
 * interruption and deadline ownership belong to the future worker scheduler. */
export async function runWorkerGroup(tests: readonly PlannedTest[], workerInfo: { workerIndex: number; parallelIndex: number } = { workerIndex: 0, parallelIndex: 0 }): Promise<WorkerGroupResult> {
  const results: SuiteTestResult[] = [], teardownErrors: PhaseFailure[] = [];
  if (!tests.length) return { results, pending: [], failedBeforeAll: undefined, teardownErrors };
  const worker = new FixtureWorker(tests[0]!.pool, workerInfo);
  // Validate the entire group without starting even an automatic fixture.
  for (const test of tests) {
    worker.validatePool(test.pool);
    test.pool.required(test.callback);
    for (const suite of test.suites) for (const hook of suite.hooks) test.pool.required(hook.callback);
  }
  const active = new Set<PlannedSuite>();
  let failedBeforeAll: PlannedSuite | undefined, completed = 0, workerClosed = false;
  try {
    for (let index = 0; index < tests.length; index++) {
      const test = tests[index]!, errors: PhaseFailure[] = [];
      const info: FiniteTestInfo = { testId: test.id, title: test.title, file: test.file, retry: 0, ...workerInfo, expectedStatus: test.expectedStatus, status: test.expectedStatus === 'skipped' ? 'skipped' : 'passed' };
      const record = (phase: FailurePhase, cause: unknown, cleanup = false): void => {
        const causes: unknown[] = cleanup && cause instanceof AggregateError ? cause.errors : [cause];
        for (const error of causes) errors.push({ phase, error });
        info.status = 'failed';
      };
      const unexpected = (): boolean => info.status !== 'skipped' && info.status !== info.expectedStatus;
      const allHooks = async (suite: PlannedSuite, type: 'beforeAll' | 'afterAll'): Promise<void> => {
        for (const hook of suite.hooks.filter(h => h.type === type)) {
          const scope = worker.beginAttempt(info, test.pool);
          try { await scope.run(hook.callback, 'all-hooks-only'); }
          catch (error) { record(type, error); }
          finally { try { await scope.close(); } catch (error) { record(type, error, true); } }
        }
      };
      const eachHooks = async (scope: FixtureAttempt, suites: readonly PlannedSuite[], type: 'beforeEach' | 'afterEach'): Promise<void> => {
        for (const suite of suites) for (const hook of suite.hooks.filter(h => h.type === type)) {
          try { await scope.run(hook.callback); } catch (error) { record(type, error); }
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
              try { await scope.run(test.callback); } catch (error) { record('body', error); }
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
      const stop = unexpected();
      if (stop) {
        // Failure shutdown belongs to this test; normal shutdown errors below
        // are separate and cannot retroactively rewrite a successful result.
        try { await worker.close(); } catch (error) { record('workerTeardown', error, true); }
        workerClosed = true;
      }
      results.push(Object.freeze({ test, status: info.status, expectedStatus: info.expectedStatus, errors: Object.freeze(errors) }));
      completed++;
      if (stop) break;
    }
  } finally {
    if (!workerClosed) {
      try { await worker.close(); }
      catch (cause) {
        const causes: unknown[] = cause instanceof AggregateError ? cause.errors : [cause];
        for (const error of causes) teardownErrors.push({ phase: 'workerTeardown', error });
      }
    }
  }
  return Object.freeze({ results: Object.freeze(results), pending: Object.freeze(tests.slice(completed)), failedBeforeAll, teardownErrors: Object.freeze(teardownErrors) });
}
