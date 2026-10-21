import { FixtureConfigurationError, type FixturePool } from './fixture-pool.js';
import type { PlannedSuite, PlannedTest } from './suite-collector.js';

export interface SuiteGroup {
  readonly file: string;
  readonly workerPool: FixturePool;
  readonly tests: readonly PlannedTest[];
}
interface FileGroups {
  general: PlannedTest[];
  parallel: Map<PlannedSuite | PlannedTest, PlannedTest[]>;
  allHooks: PlannedTest[];
}

/** Grouping is independent of dispatch. Even one worker must respect group
 * boundaries because all-hooks reenter while compatible worker fixtures live. */
export function groupTests(tests: readonly PlannedTest[], workers: number): readonly SuiteGroup[] {
  if (!Number.isSafeInteger(workers) || workers < 1) throw new FixtureConfigurationError('Worker count must be a positive integer');
  const partitions: { pool: FixturePool; files: Map<string, FileGroups> }[] = [];
  for (const test of tests) {
    test.pool.validate();
    let partition = partitions.find(p => p.pool.hasSameWorkerFixtures(test.pool));
    if (!partition) { partition = { pool: test.pool, files: new Map() }; partitions.push(partition); }
    let groups = partition.files.get(test.file);
    if (!groups) { groups = { general: [], parallel: new Map(), allHooks: [] }; partition.files.set(test.file, groups); }
    const parallel = test.suites.some(s => s.mode === 'parallel');
    const sequential = test.suites.find(s => s.mode === 'default');
    const allHooks = test.suites.some(s => s.hooks.some(h => h.type === 'beforeAll' || h.type === 'afterAll'));
    if (!parallel) groups.general.push(test);
    else if (allHooks && !sequential) groups.allHooks.push(test);
    else {
      const key = sequential ?? test;
      let group = groups.parallel.get(key);
      if (!group) { group = []; groups.parallel.set(key, group); }
      group.push(test);
    }
  }
  const result: SuiteGroup[] = [];
  for (const { pool: workerPool, files } of partitions) for (const [file, groups] of files) {
    const add = (tests: PlannedTest[]): void => { if (tests.length) result.push(Object.freeze({ file, workerPool, tests: Object.freeze(tests) })); };
    add(groups.general);
    for (const tests of groups.parallel.values()) add(tests);
    const size = Math.ceil(groups.allHooks.length / workers);
    for (let offset = 0; offset < groups.allHooks.length; offset += size) add(groups.allHooks.slice(offset, offset + size));
  }
  return Object.freeze(result);
}
