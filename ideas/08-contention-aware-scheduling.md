# Schedule for contention and fixture cost, not duration alone

**Priority:** medium to high for large parallel suites · **Scope:** mixed CPU/I/O work and uneven test groups · **Effort:** large.

Research proposal, 2026-10-29. No new measurements. Longest-first ordering, worker-hash affinity, standby workers and optional `workersPerProcess` already exist; proposing them again would add nothing.

## Remaining cost

[`orderTestGroupsByDuration`](../packages/playwright/src/runner/testDurations.ts) sums previous test durations, gives unknown tests the slowest known duration, and orders within worker-hash groups. It records the last result duration, not a robust distribution or resource demand. [`Dispatcher._findFirstJobToRun` and `_scheduleJob`](../packages/playwright/src/runner/dispatcher.ts) respect locks/project limits and prefer a matching free worker, then take the first eligible job.

[`createTestGroups`](../packages/playwright/src/runner/testGroups.ts) splits eligible parallel-with-hooks tests by count. Those equal-sized groups can have very different runtimes. None of these decisions models renderer CPU bursts, screenshot/compression work, fixture setup cost or a shared Node event loop's contention. More occupied slots can mean a later finish if all workers become CPU-bound together.

## Proposed mechanism

Build a lightweight cost history for **existing schedulable groups**: recent median/range, cold-versus-warm setup, worker hash, coarse CPU/I/O class and approximate memory demand. Key history by relevant project/browser/config and machine capacity; age it out and treat missing/stale data conservatively. Never store credentials or request bodies.

Choose placements using predicted finish time, including worker restart/fixture warmup costs and resource pressure. Keep the current worker maximum and project/lock restrictions. Pair an I/O-waiting browser with CPU-heavy work when slots permit; avoid starting multiple known CPU-heavy groups on an already saturated shared process. Schedule unavoidable long tails early, while keeping expensive worker fixtures warm when that actually shortens the finish time.

For parallel-with-hooks groups that upstream already permits splitting, balance estimated **work** instead of test count. Respect existing grouping and declaration order wherever required. Never split serial/default suites, migrate a running test, clone a live fixture or steal work whose hook/fixture lifecycle would change.

Add admission control for speculative work too: spare workers, context preparation and page preloading should yield resources when foreground work is saturated. This extends the current preparation heuristics; it does not enable `preloadPages` automatically or enlarge its observable-behavior scope.

## Functional contract

Honor dependencies, locks, retries, `maxFailures`, serial suites, hooks, worker-scoped fixture lifetimes and per-project concurrency. Keep `testOrder: 'file'` and explicit shuffle semantics. Worker identity must remain stable within a worker. Do not silently enable `workersPerProcess`: its process/global sharing is a documented opt-in difference, not a free scheduler optimization.

Start with an opt-in policy beside the current scheduler. Prefer coarse existing timing/event-loop signals over continuous expensive profiling; shared-process metrics cannot be attributed to individual lanes with false precision. Add starvation prevention and a deterministic decision log for debugging.

## Payoff and decision test

**First experiment:** change placement of existing groups only, using duration history plus measured worker-restart cost. Keep grouping and worker limits unchanged. Compare against today's longest-first scheduler with warm, empty and deliberately stale history before adding resource classification or admission control.

Suite time is governed by the last critical worker/dependency path, not the sum of test durations. The upside is removing tail idle time, repeated fixture startup and self-inflicted contention. There may be no gain on balanced suites or one-worker runs. Lower peak memory is useful only if wall time does not worsen.

Later compare 1/2/4-worker mixed workloads, skewed durations, expensive fixtures, stale histories, setup projects, locks and failure restarts. Add scheduler-focused scenarios alongside the full [matrix and old-fork comparison](01-browser-native-actions.md#payoff-and-decision-test); count speculative background CPU and memory. Run `tests/page` on `chromium-page` and `tests/playwright-test`, especially ordering, parallel/serial, fixture, shard, worker-index and multi-process-lane coverage, against pristine upstream. Reject policies that win only with perfectly trained history or trade a shorter tail for changed execution semantics.
