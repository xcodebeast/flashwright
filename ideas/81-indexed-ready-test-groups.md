# Index ready test groups without changing scheduling policy

Scope: very large suites with many small groups, project worker limits and shared-resource locks. Effort: large. Potential: remove repeated queue scans and array movement from the runner's scheduling path.

**Assessed 2026-10-31:** deferred: scheduling is a few milliseconds even for large suites; listing a 5,000-test suite takes 380 ms in total (see idea 58).

Research, 2026-10-31. Source inspection only; no suites collected, workers started or scheduler benchmarks.

## Evidence and difference from existing ideas

[`Dispatcher._findFirstJobToRun`](../packages/playwright/src/runner/dispatcher.ts) rebuilds held locks, scans the pending array and counts running workers for candidate projects. `_scheduleJob` removes the chosen entry with `splice`, then scans again to find the next group with the same worker hash for page preloading. Retries enter through `unshift` or `push`.

A long blocked prefix can be visited repeatedly while unrelated short groups finish. Array removal can also move many remaining entries. The exact cost of array movement depends on V8; repeated eligibility scans are directly visible in the source.

[Idea 08](08-contention-aware-scheduling.md) changes placement policy using cost predictions. This proposal chooses the same job and worker as today's scheduler, using cheaper bookkeeping. [Idea 58](58-selection-before-suite-cloning.md) reduces collection allocations, before this execution queue exists.

## Proposed change

Give each queued group a stable order key. Preserve the initial incoming order, front insertion for ordinary retries and tail insertion for isolated retries. Maintain per-project running counts, held-lock reference counts and free-worker indexes instead of rebuilding them on each scheduling attempt.

Group pending jobs into ordered queues with the same eligibility conditions: project limit, lock set and isolated-retry classification. Each queue exposes its earliest job. An ordered ready structure selects the globally earliest eligible head, preserving the current first-runnable rule. Worker-hash affinity remains the second decision, after choosing the job.

Use reverse indexes from locks/projects to affected eligibility classes. Lock release or project-capacity changes update those classes, not every pending group. Jobs sharing a blocked condition should not all require individual updates on each lock transition. Keep a separate per-worker-hash ordered index for the existing preload hint, including blocked groups as today's lookup does.

Start with O(1) running counts and an ordered queue representation that avoids repeated array copies. Then add indexed eligibility. Keep a small-suite path if maintaining indexes costs more than a short scan.

## Compatibility boundary

Preserve exact job priority, free-slot choice, worker reuse, stop behavior, `maxFailures`, retries and serial-group boundaries. Keep `testOrder: 'file'` and any preexisting duration/shuffle ordering untouched. Isolated retries must obey the current eligibility test, not a newly inferred stronger exclusivity rule.

Update all indexes synchronously when claiming or releasing a slot, as the current scheduler does. A worker restart awaits asynchronous shutdown after claiming a job; the reservation must remain visible during that interval. Partial startup failure and stop races must remove each entry once.

Avoid starvation introduced by class queues: globally compare order keys whenever several heads are ready. Never reorder locked groups just to improve index locality.

## Payoff and later decision

The target is runner CPU and dispatch latency when thousands of groups repeatedly encounter blocked prefixes. A suite dominated by long browser tests or one large serial group has little opportunity. Index storage is O(groups plus constraint relationships); highly unique lock combinations can reduce the advantage.

Later replay recorded scheduling inputs through old and new implementations and compare every job/slot decision, including retries and worker failure. Then measure complete large-suite runs with locked/project-limited workloads, counting index construction and cleanup.

Run runner ordering, parallelism, lock, worker and retry coverage plus the [full matrix and pristine-upstream procedure](01-browser-native-actions.md#payoff-and-decision-test), with current-fork controls and large-group additions. These are future checks; no load is generated now.
