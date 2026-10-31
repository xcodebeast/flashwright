# Track page activity in the browser scheduler instead of wrapping application APIs

Scope: timer/message-heavy applications and concurrent assertions using `failFastWhenIdle`. Effort: very large across Blink, scheduler and browser lifecycle code. Priority: architectural research with possible CPU and compatibility benefits; no established payoff on small pages.

**Assessed 2026-10-31:** deferred: browser scheduler work; `failFastWhenIdle` costs nothing measurable on the benchmark apps.

Research, 2026-10-31, against `95f3e831` and the live worktree. No runtime instrumentation or browser build performed.

## Evidence and distinct opportunity

[`idleTrackerSource`](../packages/playwright-core/src/server/idleDetector.ts) replaces page timer, animation-frame, idle-callback and message functions. It maintains Maps/Sets and a whole-document MutationObserver. A string timeout also schedules an extra cleanup timeout. Each idle query scans outstanding timers, animations, media and images; [`IdleDetector.isIdle`](../packages/playwright-core/src/server/idleDetector.ts) evaluates every frame and combines those results with Node-side activity checks.

This tracking runs in the application even when most assertions pass immediately. [Blink's scheduler](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/scheduler/README.md) already coordinates frame/page/worker task execution. Native task ownership and deadline information are possible inputs, though no existing complete Playwright idle oracle is implied.

[Idea 10](10-coordinated-virtual-time.md) advances simulated time. [Idea 14](14-browser-event-subscriptions.md) reduces diagnostic traffic. This proposal keeps real time and the existing fail-fast policy, while removing duplicate bookkeeping from application JavaScript.

## Proposed change

Add context-scoped activity epochs and conservative pending-work summaries inside the browser. Hook the actual scheduling/cancellation paths for timers, frame callbacks and messages. Maintain the next relevant timer deadline and pending counts without wrapping global functions or allocating a second JavaScript record for every callback.

Combine scheduler data with resource, animation, document and navigation state. Query these through one versioned page command that includes its frame tree. Return an activity generation and whether known work could occur before the supplied real deadline. Keep Node-side checks for other client calls, highlights, pages, workers and sockets until equivalent browser coverage exists.

The first implementation should provide native counters to the current detector, not make failure decisions more aggressive. Retain its quiet period, deadline margin and conservative exclusions. Prefer notification when an epoch changes, while avoiding one protocol event per timer or mutation; bounded coalescing can wake pending detector queries.

## Compatibility boundary

An empty runnable queue does not prove that a page cannot change. Delayed tasks, cross-frame messages, network callbacks, compositor animations and external Node actions remain possible. Unknown sources must produce “not proven idle.” This feature does not solve the existing limitation where test code schedules a future page action outside the browser's knowledge; `failFastWhenIdle: false` remains necessary there.

Coordinate cross-thread/frame observations with epochs and a confirmation barrier so an arriving task cannot race a successful idle report. Navigation/reset must invalidate outstanding queries and release old ownership records. Page-specific accounting must not treat another document's activity as this page's activity or lose shared producers.

Playwright Clock has its own JavaScript scheduler. Use its integration signals or fall back to current tracking while it is installed. Preserve timeout outcomes and call logs. Removing wrappers changes reflection of those functions; document that implementation difference and retain the existing detector as an opt-out for custom browser users.

## Payoff and later decision

Potential savings are repeated wrapper closures, Map/Set updates, observer callbacks, scans and per-frame idle-query round trips. The benefit should grow with application scheduling volume, not simply test count. Native bookkeeping can also add locks and cache misses; quiet pages may see no useful gain.

Later compare timer/message-heavy applications with tracking off, current tracking and native tracking. First require conservative agreement on idle decisions under adversarial races, then measure full passing/failing tests, application throughput, CPU and memory. Never count earlier incorrect failures as a speedup.

Build elsewhere. Run timer/Clock/worker/frame/assertion coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`, separating documented fail-fast differences. Report the full [matrix](../bench/README.md) and targeted workloads under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No execution now.
