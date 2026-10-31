# Share page-change notifications among pending waits

Scope: pages with many concurrent assertions or repeated unsuccessful action checks. Effort: large. Potential: remove work multiplied by both pending waits and DOM mutations.

**Assessed 2026-10-31:** deferred: only waits that run at the same time on one page; a test's assertions and actions wait one after another, and most pass on their first check.

Research, 2026-10-31. Source inspection only. No measurements, tests or browser execution. The current reactive waits are the baseline.

## Evidence and difference from existing ideas

[`InjectedScript.waitForChange`](../packages/injected/src/injectedScript.ts) creates a document-wide MutationObserver, eleven event listeners and a timer for every invocation. On completion it removes them all. [`Frame.waitForChangeOrTimeout`](../packages/playwright-core/src/server/frames.ts) also starts a Node timer and a browser evaluation for each wait. Concurrent waits on one document duplicate this machinery.

The [DOM standard](https://dom.spec.whatwg.org/#mutation-observers) gives each observer its own record queue and notification callback. A burst of mutations can therefore produce work for every registered wait, even though each wait needs only a change notification.

[Idea 05](05-incremental-locator-indexes.md) caches query results and proposes dependency subscriptions. This proposal caches no selector results and performs no dependency filtering. [Idea 60](60-native-browser-idle-tracking.md) proves whether work remains; this only delivers the existing wake signals more cheaply.

## Proposed change

Give each utility-world document one change-notification service. While waits exist, it owns one observer and one listener set, plus a registry of logical subscriptions. Each subscription records its registration point, deadline and cancellation identity. A change wakes the same eligible subscriptions in registration order; their ordinary checks still execute separately.

Start by sharing observer/listener registration while retaining individual browser evaluations and timeout behavior. That isolates the allocation and mutation-record savings. Disconnect when the last wait leaves, so pages with no pending checks pay no permanent observer cost.

Next, investigate one browser-to-Node notification channel per document. Node multiplexes existing waits over sequence-numbered change notifications instead of leaving one remote evaluation pending per waiter. Preserve each wait's own deadline. A notification received before a subscription began must not satisfy it. Navigation replaces the document identity and invalidates old subscriptions.

Use explicit subscribe/acknowledge/cancel messages, with generation checks around registration to avoid losing a change during the handshake. Keep the existing periodic fallback: property writes, CSSOM changes and other activity can escape the current observer/event set.

## Compatibility boundary

Sharing observers can change callback placement relative to application observers. Persistent event listeners can also change behavior around `stopImmediatePropagation`. These are design constraints, not details to ignore. Preserve the required notification checkpoints and logical callback order; if JavaScript sharing cannot do that, keep affected paths unchanged or implement equivalent browser hooks before enabling it.

Do not run arbitrary `waitForFunction` predicates less often, combine assertion evaluations into one atomic snapshot, shorten timeouts or change idle failure policy. Preserve fake-clock handling, timeout diagnostics, frame detachment and cancellation. A timed-out Node wait must release its browser subscription rather than waiting for a later browser timer.

## Payoff and later decision

With W waits and M queued mutations, shared observation targets the duplicated W × M record work, plus repeated listener setup. W result notifications and the actual selector checks still remain. Sequential, immediately passing assertions may gain almost nothing.

Later compare concurrent waits over quiet and rapidly changing documents, including application observers and event propagation. Measure complete assertion latency, mutation CPU, allocations and retained subscriptions. Reject sharing if event ordering changes or a single wait becomes slower enough to erase suite gains.

Use the [full matrix and upstream comparison procedure](01-browser-native-actions.md#payoff-and-decision-test), adding concurrent-wait rows and the current-fork baseline. Cover page assertions, action retries, cancellation, clocks and `tests/playwright-test`. Defer all execution until the benchmark machine is available.
