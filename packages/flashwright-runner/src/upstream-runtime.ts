import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { TestInfo } from 'flashwright-upstream-runner/test';

/** All runtime imports share the owned pinned tree, including the worker's private globals. */
export const upstreamDirectory = join(__dirname, '..', 'upstream');
export const upstreamRequire = createRequire(join(upstreamDirectory, 'package.json'));
export const runnerGlobals = upstreamRequire('./lib/globals.js') as { currentTestInfo(): TestInfo | undefined };
export const runnerHooks = upstreamRequire('./flashwright-hooks.cjs') as {
  installTraceStart(callback: (testInfo: TestInfo, policy: unknown) => boolean): void;
};
