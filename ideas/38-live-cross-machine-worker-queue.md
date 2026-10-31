# Balance complete test workers across machines during the run

**Scope:** large CI suites with uneven shards and remote execution capacity. **Effort:** very large. **Priority:** high for long distributed suites; low for short local runs.

**Assessed 2026-10-31:** deferred: distributed execution, outside a single run's speed.

Research proposal, 2026-10-31. No machines provisioned, workers started or measurements taken. This extends execution beyond one host; [idea 08](08-contention-aware-scheduling.md) concerns local placement, and [idea 34](34-dependency-ready-project-execution.md) removes local project barriers.

## Evidence

[`filterForShard`](../packages/playwright/src/runner/testGroups.ts) partitions groups using active test counts and optional shard weights. Once separate shard commands start, a finished shard cannot take an unstarted group from a slow sibling. [Upstream sharding](https://playwright.dev/docs/test-sharding) already distributes tests and merges reports, so merely recommending more CI jobs is not a new optimization.

[`WorkerHost`](../packages/playwright/src/runner/workerHost.ts) delegates execution to local [`ProcessHost`](../packages/playwright/src/runner/processHost.ts) instances. Connecting to a distant browser leaves test control flow on the original host. The opportunity is a live cross-machine group queue with the test worker and browser colocated on each executor.

## Proposed change

Add a remote WorkerHost adapter behind the existing runner event interface. A coordinator assigns existing, not-yet-started groups to available executors. Each executor runs fresh Node workers and local browsers against an identical immutable project/dependency image. Keep browser calls local; transmit group assignments, runner events and artifacts across machines.

Start with already-shardable projects using external reachable services or independently provisioned per-executor backends. Preserve group boundaries and worker-fixture affinity. Do not migrate a running test or divide a serial group. Duration history can improve initial choices, but pulling another group after finishing removes some imbalance even with no history.

Use unique assignment/attempt IDs, an ordered event stream and acknowledgements. A disconnected executor has an uncertain outcome: do not quietly run the same side-effecting test elsewhere. Mark the attempt interrupted, fence or stop its old execution, and apply the configured retry policy. No speculative duplicate attempts.

Keep global project dependencies, locks, `maxFailures` and worker limits at the coordinator. Initially retain current project phases; combining this with dependency-ready projects is a separate change. Bound event/artifact queues and complete required artifact transfer before reporting a finalized result.

## Compatibility

Remote workers need declared inputs, environment, OS/runtime/browser identity and reachable services. Localhost, absolute paths, native dependencies and external filesystem writes are not transparently portable. Provide explicit distributed configuration and document it in README; unsupported projects remain local or use normal shards.

Preserve workerIndex uniqueness, parallelIndex slot identity, retries, beforeAll/afterAll lifetimes, per-worker stdout ordering and reporter object semantics. Coordinator arrival time is not the same as worker event time; retain source durations and avoid pretending clocks are perfectly synchronized. Worker fixture teardown and cancellation must finish or report an infrastructure failure.

## Payoff and later decision

At fixed hardware, the opportunity is idle capacity stranded behind static shard assignments. With added machines, wall time can also fall through more parallelism, but report that separately from efficiency. Total work divided by capacity and the longest indivisible group remain lower bounds. Image distribution, startup, backend contention and artifact traffic can erase gains.

First compare the same number and type of executors using static shards versus a live queue, with skewed durations and deliberately stale history. Include executor loss, duplicate messages, late results, locks, cancellation and cleanup. Count aggregate CPU, memory and executor-seconds as well as elapsed time.

Later run sharding/parallel/retry/reporter coverage, `tests/playwright-test` and `tests/page` on `chromium-page` against pristine upstream in `workbench/pw-src`. Keep the local `node bench/matrix.mjs` and `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` controls; report a separate equal-hardware distributed matrix under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Defer execution until capacity is available.
