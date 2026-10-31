# Start each project when its own dependencies finish

**Scope:** suites with several setup projects or uneven dependency branches. **Effort:** large. **Priority:** high when global phase barriers leave usable workers idle.

Research proposal, 2026-10-31. No execution or measured speedup. This removes project-level barriers; [contention-aware scheduling](08-contention-aware-scheduling.md) chooses placements within available work, and [parallel web servers](27-parallel-web-server-startup.md) concerns a different setup mechanism.

## Evidence

[`createPhasesTask`](../packages/playwright/src/runner/tasks.ts) groups projects into topological layers. `createRunTestsTask` awaits a whole layer's `dispatcher.run()` and `dispatcher.stop()` before processing the next layer. Preparing the next phase's workers already overlaps startup, but does not release its tests early.

Suppose independent setup projects A and B take 1 and 60 seconds. Project C needs only A and takes 60 seconds. With enough free workers, the phase barrier gives roughly 120 seconds; dependency-ready execution could finish near 61. These are illustrative durations, not measurements. [Playwright's dependency contract](https://playwright.dev/docs/test-projects#dependencies) requires prerequisites to succeed; the current implementation also waits for unrelated projects in the same phase.

## Proposed change

Replace the phase loop with a run-level dependency graph and one shared worker budget. A project becomes eligible when all its prerequisites have successfully finalized. Enqueue its existing test groups immediately; preserve the current grouping, serial suites and within-group order.

Finalized must mean more than receiving the last `testEnd`. Finish retries, worker-scoped fixture teardown, errors and produced environment variables. Today produced environment is collected after dispatcher shutdown. Add a project-completion operation that retires only that project's workers and freezes its outputs before releasing successors.

Represent teardown projects as dependency edges from the entire relevant dependent closure, as `buildTeardownToSetupsMap` and the current phase builder do. Cleanup eligibility must survive `maxFailures`, interruption and failed setup. Keep one global lock registry and global/project concurrency limits across all simultaneously eligible projects.

## Compatibility

Do not start a dependent on a merely passing attempt whose teardown can still fail. Preserve dependency failure propagation, environment merge precedence, worker errors, reporter events and cleanup guarantees. A project that fails to finalize must never release its dependents. Unattributable fatal worker errors retain conservative run-wide handling.

Earlier overlap between formerly separate phases changes observable ordering. Introduce an explicit scheduling policy initially, document it in README, and keep phase scheduling as the opt-out. A project using another project's files or external state must declare that dependency; do not infer independence from test names. Changing worker count or splitting hooks is outside this proposal.

## Payoff and later decision

The upper opportunity is the difference between the current sum of phase completion times and the dependency graph's critical path, subject to worker limits. A simple setup-then-tests suite has no such gap. More simultaneous projects can increase memory or backend contention, so admission control may still leave some eligible work queued.

First implement project finalization and readiness with the current placement policy. Later compare exact dependency/environment/teardown event sequences on diamonds, uneven branches, retries, teardown failures and cancellation. Measure complete run time and occupied/idle worker intervals; include cases where workers are already saturated.

When capacity is available, run project-dependency, fixture and worker-error coverage in `tests/playwright-test`, plus `tests/page` on `chromium-page`, against pristine upstream in `workbench/pw-src`. Report an added branching-project workload beside the full `node bench/matrix.mjs` and `node bench/run.mjs <scenario> <workers> <iterations> stock,fork`. Include the current fork and both scheduling policies under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No experiments now.
