# Resolve large CSS invalidations across cores

Scope: applications with large DOMs, complex styles and repeated broad style invalidation. Effort: monumental browser-engine work. Priority: exploratory, with a substantial ceiling only on style-bound pages.

**Assessed 2026-10-31:** rejected for now: browser style-engine work. Style, layout and paint are ~9% of renderer main-thread time on TodoMVC (~2 ms per test).

Research, 2026-10-31. Local source inspection and primary-source research only; no browser profiles or build.

## Where the work is

Flashwright's [`domUtils`](../packages/injected/src/domUtils.ts) and [injected script](../packages/injected/src/injectedScript.ts) request computed styles and element geometry for visibility, hit testing and assertions. Those reads can force the browser to bring style/layout up to date. Faster selector lookup cannot remove required rendering work after the application invalidates a large tree.

[Blink's style documentation](https://chromium.googlesource.com/chromium/src/+/master/third_party/blink/renderer/core/css/style-calculation.md) describes indexed rule matching followed by computed-style construction and tree traversal. It is incomplete and partly historical: it does not prove a bottleneck in the pinned browser. [Firefox's current architecture documentation](https://firefox-source-docs.mozilla.org/layout/StyleSystemOverview.html#quantum-css-stylo) establishes that a parallel Rust style system is feasible in a production browser.

The new target is parallel execution of expensive eligible style work in Chromium. [Idea 05](05-incremental-locator-indexes.md) indexes automation queries, [idea 18](18-automation-trained-browser-build.md) tunes native compilation, and [idea 31](31-per-test-browser-capability-contracts.md) omits capabilities. This proposal retains the complete styling result.

## Proposed change

Keep Blink's existing invalidation and matching caches. At an ordinary style-update boundary, identify sufficiently large independent work units. Freeze the necessary read view of DOM, rules and inherited parent style, then compute eligible subtrees through a bounded worker pool. Publish results at the same lifecycle boundary before layout or script observes them.

Begin with rule matching and computed-style construction for ordinary subtrees whose dependencies are understood. Parent results must be ready before descendants inherit them. Use worker-local scratch storage and an immutable rule representation; do not clone the whole DOM for each update. Main-thread-only effects remain ordered there.

Modern CSS creates dependencies beyond parent inheritance: container queries, `:has()`, counters, shadow/slot relationships, animations and custom properties. Model supported dependencies explicitly and use the original path when the graph cannot be partitioned safely. A worker must not access thread-affine Blink objects merely because JavaScript is currently paused.

Rust is an implementation option if it makes ownership and parallel traversal tractable. Replacing Blink with Firefox's CSS semantics is not the plan: Chromium-specific behavior and existing supported CSS must remain compatible.

## Compatibility boundary

Preserve computed values, cascade order, layout geometry, hit targets, screenshot pixels and lifecycle callbacks. Synchronize animation sampling to one timestamp for the update. Keep resource discovery and observable effects in the same order; parallel matching must not reorder font/image requests or script-visible callbacks.

Do not change layout algorithms or frame cadence in the first version. Keep serial execution for small updates, unsupported CSS and machines already saturated by test workers. Share a process-wide work budget with other browser background jobs; one pool per page would oversubscribe the machine.

## Payoff and first decision

If style work dominates a navigation or action, parallelism can shorten that operation even at one test worker. It will not speed up network waits or serial application JavaScript. Extra synchronization, memory bandwidth and lost cache locality can outweigh the benefit, especially with four busy browsers.

First establish actual style-update cost and available parallel work in the pinned engine on held-out large pages. Then prototype one restricted style pass against the same build's serial implementation. Compare complete computed styles, geometry, resource ordering and pixels before making a speed claim.

Build elsewhere. Later run CSS/web-platform tests, selectors/visibility/input/screenshot coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report the entire [benchmark matrix](../bench/README.md), current-fork controls and style-heavy one/four-worker cases under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Count all helper-thread CPU and peak memory; reject gains obtained by taking capacity away from other tests.
