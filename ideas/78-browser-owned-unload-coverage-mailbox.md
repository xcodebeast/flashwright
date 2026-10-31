# Save document-exit coverage outside application storage

Scope: Istanbul-instrumented applications with large coverage maps and multi-origin navigation. Effort: very large, requiring browser integration. Potential: remove synchronous storage writes and recovery navigations from coverage runs.

**Assessed 2026-10-31:** deferred: coverage runs only, and it needs browser integration.

Research, 2026-10-31. Source inspection and browser-lifecycle research only; no coverage runs or browser changes.

## Evidence and difference from existing ideas

[`CoverageScript._stashCurrent`](../packages/injected/src/coverageScript.ts) handles `pagehide` by collecting counter deltas, serializing JSON and synchronously writing a `__pwCoverage.*` localStorage entry. A fresh document tracks its own first report, so substantial statement/function/branch maps can accompany the saved counters. The code explicitly notes that ordinary unload-time calls are not reliably delivered.

[`CoverageRecorder._harvestOriginsWithoutPage`](../packages/playwright-core/src/server/coverageRecorder.ts) later visits origins with no live page to recover those stashes. Deltas already exist; proposing delta reporting again would be redundant. The remaining cost is the durable handoff through application storage and its navigation-based retrieval.

[Idea 47](47-jit-compatible-precise-coverage.md) changes V8 precise coverage. This targets Istanbul counters exposed through `__coverage__`. [Idea 44](44-storage-state-without-origin-navigation.md) restores user storage; this removes an internal coverage transport's need to use storage at all.

## Proposed change

Add a context-owned coverage mailbox to the browser. A private native entry point accepts a captured coverage chunk while its document still exists and transfers ownership to a collector that survives renderer/frame destruction. The runner drains the mailbox directly, without opening a page for each departed origin.

Keep the current capture point initially: the same installed `pagehide` handler computes the same delta and serialization. Replace only the localStorage write. Browser [frame teardown](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/frame/local_frame.cc) is an integration boundary to study, not an existing guarantee that an asynchronous binding will finish.

The ownership handoff must complete before the document's data can disappear. An ordinary `exposeBinding` call followed by immediate navigation is insufficient. Use a native copy or a retained buffer with a teardown barrier, and account for that barrier in the timing.

Give chunks session, document-generation and sequence identities. Drain exactly once logically, allowing transport retries without double-counting. Keep existing counter merging and output format. Later, separately investigate registering immutable maps once per verified instrumentation identity; the first milestone should change only the transport.

## Compatibility boundary

Preserve when counters are sampled relative to application pagehide/unload handlers. Moving sampling to a later destruction hook could include additional statements and change totals. Preserve zero-hit files, branch positions, resets, retries, popups and same-origin documents sharing a session.

Bound mailbox bytes and define overload handling before shipping. The producer cannot silently drop coverage. Retaining the current stash path for an unsupported engine or a preselected fallback mode is acceptable; switching after losing ownership is not. Renderer/browser crashes must retain the current documented guarantees and surface collection failures where required.

Removing internal localStorage keys and their storage events is an observable improvement in isolation, but still a behavior difference. Document it and retain the original collection backend as an opt-out. Ordinary application storage, quota and `storageState` contents must remain under the application's control.

## Payoff and later decision

The largest opportunity is repeated navigation across many origins with large instrumentation maps. Removing recovery documents can shorten final coverage collection; avoiding storage serialization/writes can shorten navigation itself. JSON generation and counter scanning still remain in the first version.

Later compare exact coverage output and per-handler sample boundaries through navigation, close, reload and cancellation. Measure navigation plus final drain, including collector memory and fallback costs. Run library/runner coverage suites and the [full matrix and upstream comparison](01-browser-native-actions.md#payoff-and-decision-test), with coverage-heavy additions and current-fork controls. Build elsewhere; do not experiment on this machine now.
