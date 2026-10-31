# Make simulated-clock execution scale with fired timers

Scope: Clock-based tests with many concurrent timers, animation callbacks or simulated intervals. Effort: medium for indexing; large for a faster task-yield mechanism. Priority: strong within timer-heavy workloads.

**Assessed 2026-10-31:** deferred: only tests with many simulated timers.

Research, 2026-10-31, against `2bc2768b` plus the live worktree. No timers, tests or benchmarks executed.

## Evidence and opportunity

[`ClockController._firstTimer`](../packages/injected/src/clock.ts) scans the entire timer Map to choose one callback. `_runTo` repeats that selection after each callback; `_updateRealTimeTimer` also scans during active-clock timer registration. Draining N one-shot timers can perform a quadratic number of comparisons before accounting for callback work.

`_callFirstTimer` then yields through an original browser `setTimeout` after every callback. This is a real task boundary, not a simulated delay. The [HTML timer rules](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers) impose a minimum delay on sufficiently nested timers. Whether this particular chain reaches that clamp in each shipped engine remains unmeasured; do not assign it a fixed per-callback cost without evidence.

[Idea 10](10-coordinated-virtual-time.md) automatically advances time across cooperating systems. This proposal accelerates execution of the explicit Clock commands that tests already use.

## Proposed change

Keep the ID Map for lookup and add an indexed min-heap ordered by the existing `compareTimers`: deadline, Immediate priority, creation time and timer ID. Adding, canceling and rescheduling an interval update both structures. Peek becomes constant time; insertion/removal become logarithmic.

Preserve rescheduling before callback invocation, so an interval can cancel itself exactly as today. Store heap positions or use versioned entries with bounded compaction; canceled long-lived timers must not accumulate forever. When `fastForward` changes many deadlines at once, adjust them in one pass and rebuild the heap in linear time. Retain a small-queue scan if it wins for ordinary pages.

Evaluate task yielding separately. A browser task continuation could avoid unnecessary real timer delay while still allowing microtasks, messages, network and rendering to progress between callbacks. A MessageChannel or scheduler task is only a candidate: changing task sources can change interleaving. Do not replace the yield with `Promise.resolve()` or run all callbacks synchronously. If equivalent scheduling cannot be maintained, ship the heap alone; any accelerated-yield mode needs an explicit contract and opt-out.

## Compatibility boundary

Keep `runFor` versus `fastForward` semantics, rounding, equal deadlines, zero-delay intervals, nested registration, string callbacks, cancellation and first-exception handling. Preserve `_duringTick`, monotonic ticks, fixed/system time and real-time resume behavior. Do not alter the growing navigation replay log as part of this change.

## Payoff and later decision

The heap removes repeated whole-queue selection work without skipping callbacks. It can reduce CPU and latency for large timer populations; it does little when only one timer exists. Real task yields or application callbacks may still dominate, so a faster heap microbenchmark is insufficient.

Later compare exact callback/microtask sequences with the reference scan using unit Clock tests and `page-clock` coverage. Include cancellation storms, tied deadlines, intervals and navigation. Measure full Clock calls and complete suites, with both many-live-timer and one-live-timer controls. Run upstream page/runner suites against pristine upstream and report the complete [benchmark matrix](../bench/README.md), current-fork comparisons and timer-heavy additions under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Test the heap and yield changes independently when capacity is available.
