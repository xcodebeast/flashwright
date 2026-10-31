# Lay out independent page regions across cores

Scope: large dashboards, editors and documents where geometry computation dominates interaction or capture. Effort: monumental Blink work. Potential: shorten the renderer's layout critical path while preserving the same page geometry.

**Assessed 2026-10-31:** deferred: browser engine work.

Research proposal, 2026-10-31. Architectural investigation only; no engine build, trace or benchmark collected.

## Evidence and distinct opportunity

Flashwright still relies on real browser geometry for [`ElementHandle._clickablePoint`](../packages/playwright-core/src/server/dom.ts) and [`Screenshotter`](../packages/playwright-core/src/server/screenshotter.ts). Removing driver waits does not remove layout required by those operations or by application geometry reads.

Chromium's [LayoutNG description](https://developer.chrome.com/docs/chromium/layoutng) explains explicit parent constraints, immutable output fragments and reuse of prior fragments. It also describes paragraph caching and the difficulty of multi-pass layout. These existing mechanisms are the starting point. This proposal does not assume that Blink lacks layout caching or that an immutable fragment makes all layout code thread-safe.

[Idea 49](49-parallel-browser-style-resolution.md) parallelizes CSS matching and computed styles. This proposal begins after styles are available and computes box sizes, positions and fragments. Style work and layout work need separate attribution; their predicted savings cannot simply be added.

## Proposed change

Identify independent layout work units at an ordinary layout boundary. Freeze their required style, font and geometry inputs, compute eligible fragments on bounded helper threads, then publish results in the original layout order before script or paint can observe them.

Start with subtrees whose outer dimensions and incoming constraints are already fixed and whose descendants cannot affect sibling sizing. Existing containment can help prove this, but layout containment alone does not imply size independence. Do not inject CSS containment into user pages. Keep unsupported dependency patterns on the current main-thread path.

Represent the remaining dependencies explicitly: parent constraints before child layout; intrinsic sizes before any parent pass that needs them; fragment placement after relevant sizes are known. Schedule only ready work. A large flex/grid algorithm may require several ordered stages and offer little parallelism despite having many children.

Refactor a narrow layout kernel to consume an immutable input view and produce thread-owned fragments. Main-thread Blink objects cannot be accessed freely from workers. Keep resource discovery, mutable caches and observer registration on their required threads, or move them behind verified ownership boundaries. Reuse existing fragments before scheduling new work.

Use a browser-wide helper budget informed by active test workers. A single test on an idle multicore machine may benefit; four renderer tests already saturating four cores should generally receive no extra layout threads. Avoid copying the entire DOM/style tree to obtain one parallel pass.

## Compatibility boundary

Require identical box geometry, line breaking, intrinsic sizes, scrolling and hit testing. Preserve fonts, bidi text, writing modes, floats, margin collapse, fragmentation, sticky/out-of-flow positioning, container dependencies and subgrid behavior. Unknown dependencies force serial layout.

Publish at the same lifecycle boundary. Script must never observe partially installed fragments. ResizeObserver loops, synchronous layout reads, selection and accessibility geometry retain their ordering and errors. Navigation/cancellation must retire worker tasks safely without retaining old documents or publishing results into a new one. No weaker layout semantics are acceptable as the default optimization.

## Payoff and later decision

The ceiling depends on layout time on the critical path and the fraction that can execute independently. More cores cannot accelerate inherently serial constraints. Parallelization can reduce latency while increasing total CPU; resource efficiency is not promised. A browser fork is justified only by meaningful whole-suite gains on held-out layout-heavy apps.

Later compare fragment trees and geometry against serial LayoutNG, then run CSS/layout web-platform tests, selectors, input, screenshots and upstream page/runner suites against pristine upstream. Report unchanged small-page controls and one/multiworker cases with the [full matrix](../bench/README.md). Include helper-thread CPU, task overhead, retained memory and all synchronization. Build on another machine; do not touch the ongoing benchmarks.
