# Schedule headless rendering when an awaited operation needs a frame

Scope: apps that reveal state through animation-frame callbacks, canvas rendering or successive rendering updates. Effort: very large. Potential: remove display-cadence gaps from frame-bound tests. Explicit opt-in is required.

**Assessed 2026-10-31:** deferred: a faster frame cadence changes what pages see (callback counts and timestamps), so it can only be opt-in; the earlier begin-frame-control experiment broke waits.

Research proposal, 2026-10-31. Source and protocol research only; no browser launch or flag experiment.

## Evidence and distinct opportunity

Flashwright removes many action-side frame waits, but application `requestAnimationFrame` callbacks still depend on the browser rendering schedule. [`Frame.waitForFunctionExpression`](../packages/playwright-core/src/server/frames.ts) also uses animation-frame polling when no numeric interval is supplied. Reactive DOM notifications cannot wake a condition before the application produces its next frame-dependent update.

The local [Chromium protocol](../packages/playwright-core/src/server/chromium/protocol.d.ts) defines `Target.createTarget.enableBeginFrameControl` and `HeadlessExperimental.beginFrame`. The [official command documentation](https://chromedevtools.github.io/devtools-protocol/tot/HeadlessExperimental/) says a BeginFrame can complete rendering and optionally capture a screenshot; its default reported interval is about 16.7 ms. These primitives establish a research path, not a supported general scheduler for Flashwright.

[Idea 10](10-coordinated-virtual-time.md) advances simulated time to timer deadlines. This proposal keeps real time and changes when eligible rendering work is scheduled. [Idea 01](01-browser-native-actions.md) moves action control flow; it does not remove frame-cadence waiting inside the application.

## Proposed change

Add an optional headless scheduling mode. While an automation operation is waiting for frame-produced state, let the browser issue the next needed rendering opportunity once the previous frame and required tasks have completed, instead of waiting for the normal display interval. Keep one frame in flight per target and a bounded rate.

Prototype with controlled BeginFrame targets in a version-pinned headless shell. Maintain the ordinary cadence when acceleration is inactive; enabling manual frame control must not freeze animations between Playwright calls. Keep timestamps tied to the same monotonic clock, and do not fast-forward timers or animation duration.

The production design belongs beside the browser scheduler. It needs a reliable pending-frame-work signal, cancellation and coordination across renderer frames and compositor surfaces. A Node loop issuing frames continuously can waste cores and merely move the bottleneck. Do not depend on historical `needsBeginFramesChanged` examples without checking the pinned protocol and implementation.

Respect the normal task/microtask and rendering lifecycle between frames. On completion or cancellation, stop accelerated requests and restore ordinary scheduling. Start with one page and no media; unsupported capture, frame-tree or device configurations keep the normal browser path.

## Compatibility boundary

Higher frame cadence changes callback counts, timestamps between callbacks and frame-based animation speed. It can expose different intermediate states even though wall-clock time is unchanged. Document that contract in README, report the mode in results and retain ordinary scheduling as the opt-out. Never label it invisible drop-in acceleration.

Do not suppress ResizeObserver/IntersectionObserver delivery, input acknowledgements, layout, paint or compositor synchronization. Time-based animations must still use real elapsed time. Video, audio, WebXR, GPU fences and user-controlled clocks need explicit handling or fallback. Keep external test deadlines on real time and prevent a perpetual animation loop from starving network and Node callbacks.

## Payoff and later decision

For a test waiting through `F` successive frame-dependent updates, the opportunity is the cadence gaps that sit on its critical path. It cannot remove the updates' actual CPU work or a real-duration animation. High-frequency frames may increase CPU and reduce multiworker throughput.

Later compare chained-rAF applications, canvas updates, mixed timers/network and zero-animation controls. Record callback ordering/timestamps as well as pixels and outcomes. Run browser scheduling/web-platform tests and upstream page/runner suites against pristine upstream, with mode-specific expectations kept explicit. Report single/multiworker results beside the [full matrix](../bench/README.md), counting every rendering task. Reject a one-page gain that slows complete suites through contention. Browser work belongs on separate capacity.
