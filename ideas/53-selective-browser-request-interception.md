# Pause only browser requests that could match a route

Scope: applications with many assets and a few API mocks. Effort: large. Priority: strong candidate using ordinary Chromium, with no new test syntax.

**Assessed 2026-10-31:** deferred. Measured: with one `page.route` that matches nothing, a page with 80 subresources loads in 28.5 ms instead of 22.1 (~0.08 ms per paused request); a typical app with a handful of requests loses well under a millisecond per navigation. Narrower `Fetch.enable` patterns would leave some requests unpaused, and the network manager pairs `requestWillBeSent` with `requestPaused` for every request while interception is on: that pairing would have to predict Chromium's pattern matching exactly.

Research, 2026-10-31, against `95f3e831` and the live worktree. Source inspection and primary documentation only; no measurements or browser execution.

## Evidence and distinct opportunity

[`CRNetworkManager._updateProtocolRequestInterceptionForSession`](../packages/playwright-core/src/server/chromium/crNetworkManager.ts) enables `Fetch` with `urlPattern: '*'` whenever request interception is enabled. A route for one API endpoint therefore puts unrelated scripts, images and stylesheets through browser pause/continue coordination too. [`PageDispatcher.setNetworkInterceptionPatterns`](../packages/playwright-core/src/server/dispatchers/pageDispatcher.ts) has URL matchers, but they currently select callbacks after this browser boundary.

[CDP Fetch patterns](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#type-RequestPattern) can restrict which requests pause. Their wildcard language differs from Playwright's, so forwarding strings unchanged is unsafe. [Idea 21](21-compiled-network-route-matching.md) speeds up handler selection after interception; [idea 06](06-browser-local-har-routing.md) moves HAR replay. This proposal prevents unrelated requests from entering interception at all.

## Proposed change

Carry conservative pattern metadata from page/context route registration to the browser network manager. Compile supported Playwright globs into a union of CDP patterns that matches every request the original routes could handle. Extra matches are acceptable; missing one is a correctness failure. Begin with literal URLs and simple origin/path prefixes. Keep Node's exact matcher and callback precedence unchanged.

For example, a test mocking `/api/orders` should leave unrelated `/assets/...` requests on Chromium's ordinary path. Complex regexes, URL predicates and unsupported pattern syntax can force the affected target back to `*`. Internal interceptors, HAR, resource blocking and authentication must participate in the union. An interceptor without trustworthy metadata means intercept everything.

Install changes on every relevant session, including newly attached frames and workers. Registration must await acknowledgement before returning. When rules change while requests are paused, complete those requests under the existing callback/snapshot semantics; do not strand their interception IDs. Pattern updates require more than the current enabled/disabled boolean, which otherwise suppresses updates while interception remains enabled.

Keep HTTP cache disabling exactly as today. Turning caching back on would alter request observations and is outside this proposal. Preserve normal Network events for requests that no longer pause; tracing, HAR, navigation bookkeeping and `waitForResponse` still need them.

## Compatibility boundary

Preserve page-before-context precedence, redirects, URL rewriting through fallback, `times`, unroute races, authentication challenges and service-worker limitations. Start with no credentials and no unknown internal interceptors. Expand only when authentication and redirect handling are proven with narrowed Fetch patterns.

Some existing bookkeeping pairs Network events with Fetch events. Audit and support the mixed case where only some requests have a Fetch ID. Preserve public request/response identity and header completion. Retain an interception-wide fallback switch. No intended public behavior change; any unavoidable event-order difference needs explicit documentation and an opt-out before release.

## Payoff and later decision

The target is eliminating pause/continue exchanges for `all requests minus candidate requests`, including browser scheduling and driver work. Savings can grow with hundreds of assets per navigation; a catch-all route gains nothing. Concurrent requests mean exchange counts cannot be multiplied into a claimed wall-time saving.

Later compare selective and catch-all routes on the same asset-heavy app, including rule changes during navigation. Record paused-request count, complete navigation time, callbacks, response bodies, CPU and memory. Reject a command-count improvement without faster complete runs.

Run routing, auth, frame and service-worker coverage plus `tests/page` on `chromium-page` and `tests/playwright-test`, comparing failures with pristine upstream in `workbench/pw-src`. Report targeted rows and the entire [benchmark matrix](../bench/README.md), including current-fork controls under the [shared evaluation rules](01-browser-native-actions.md#payoff-and-decision-test). Defer all execution while this machine is busy.
