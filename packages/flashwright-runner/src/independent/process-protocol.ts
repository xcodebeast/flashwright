import { createHash } from 'node:crypto';
import type { PlannedTest, ExpectedStatus } from './suite-collector.js';
import type { SuiteGroup } from './suite-groups.js';
import type { SuiteTestResult, SuiteWorkerInfo, PhaseFailure } from './suite-runtime.js';

export interface ProcessSuiteModule {
  loadSuite(info: SuiteWorkerInfo): Promise<readonly PlannedTest[]> | readonly PlannedTest[];
  onResult?(result: SuiteTestResult): unknown;
  onWorkerEnd?(errors: readonly PhaseFailure[]): unknown;
}
export interface ProcessTest { id: string; title: string; file: string; expectedStatus: ExpectedStatus; callbackHash: string }
export interface ProcessGroup { id: number; workerKey: number; tests: string[] }
export interface ProcessPlan { tests: ProcessTest[]; groups: ProcessGroup[] }
export interface ProcessFailure { phase: string; message: string; stack?: string }
export interface ProcessTestResult {
  id: string; retry: number; status: 'passed' | 'failed' | 'skipped' | 'timedOut' | 'crashed';
  expectedStatus: ExpectedStatus; workerIndex: number; parallelIndex: number;
  errors: ProcessFailure[]; duration: number;
}
export interface RunRequest { type: 'run'; token: number; group: number; attempts: { id: string; retry: number }[] }
export function failure(error: unknown, phase: string): ProcessFailure {
  try {
    if (error instanceof Error) return { phase, message: error.message, stack: error.stack ?? '' };
    return { phase, message: String(error) };
  } catch { return { phase, message: 'Error could not be serialized' }; }
}
export function processPlan(tests: readonly PlannedTest[], groups: readonly SuiteGroup[]): ProcessPlan {
  const pools: SuiteGroup['workerPool'][] = [];
  return {
    tests: tests.map(test => ({ id: test.id, title: test.title, file: test.file, expectedStatus: test.expectedStatus, callbackHash: createHash('sha256').update(test.callback.toString()).digest('hex') })),
    groups: groups.map((group, id) => {
      let workerKey = pools.findIndex(pool => pool.hasSameWorkerFixtures(group.workerPool));
      if (workerKey < 0) { workerKey = pools.length; pools.push(group.workerPool); }
      return { id, workerKey, tests: group.tests.map(test => test.id) };
    }),
  };
}
