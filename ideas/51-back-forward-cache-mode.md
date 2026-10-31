# Support the browser's back-forward cache for history-heavy tests

Scope: tests that revisit complete documents with browser back/forward navigation. Effort: large for correct lifecycle integration. Priority: high potential within that workload; explicit opt-in.

**Assessed 2026-10-31:** deferred. Restoring a page from the back-forward cache changes what the application sees (no reload, `pageshow` with `persisted`, requests that bypass routing), so it can only be an opt-in for history-heavy suites.

Research, 2026-10-31, against `c4c3583b` and the live worktree. No launch flags changed or browser started.

## Where the work is

[`chromiumSwitches`](../packages/playwright-core/src/server/chromium/chromiumSwitches.ts) disables the back-forward cache. Its comment gives a concrete reason: a restored page can bypass request interception during `page.goBack()`. Consequently, eligible history navigations cannot use Chromium's normal full-document restoration.

The [browser's back-forward cache](https://web.dev/articles/bfcache) preserves a suspended document and its JavaScript heap, avoiding repeated fetch, parse and application execution when returning to it. It does not accelerate an SPA's same-document route changes. This differs from `preloadPages`, which speculates about a future test's first navigation, and from bytecode reuse, which still executes application initialization.

## Proposed change

Add an explicit history-cache mode and omit the disabling switch only for compatible browser launches. Include the mode in warm-session and browser-sharing identities so an ordinary project cannot inherit a browser with different navigation semantics.

Treat restore as its own lifecycle path. The local [CDP schema](../packages/playwright-core/src/server/chromium/protocol.d.ts) already identifies `BackForwardCacheRestore`, while [`FrameSession`](../packages/playwright-core/src/server/chromium/crPage.ts) currently forwards `frameNavigated` using its frame payload without that event type. Carry restore identity into frame/navigation bookkeeping.

Reassociate restored execution contexts, utility worlds and frame trees. Resume existing init-script effects and application globals instead of running init scripts again. Resolve navigation waits using an explicit restore completion signal; do not wait for a new network request or fabricate a response. Define and test the public return value for a history restoration with no response.

Preserve Chromium's own eligibility and eviction decisions. A rejected or evicted entry follows normal navigation. Do not force-cache pages with unsupported active resources. Start with ordinary pages and no tracing/video, then extend artifact support only when restoration can be represented faithfully.

## Compatibility boundary

This changes observable behavior: fewer network/route callbacks, retained page globals and form state, and native pagehide/pageshow behavior. It must remain an explicit mode with differences documented in README and cache-disabled navigation as the opt-out. It is useful for tests intended to exercise real browser history behavior; it cannot transparently accelerate tests that require a fresh request on every back action.

Routing does not turn a cache restoration into a request. Define unsupported combinations up front or require callers to accept native restore semantics; never replay route handlers against imaginary traffic. Preserve cancellation, waitUntil handling, dialogs, frames and timeout accounting.

Cache entries belong to one attempt. Destroy or evict them at context reset/close so restored state cannot cross test boundaries. Memory usage may increase substantially; retain browser limits and count cached documents in the total footprint.

## Payoff and first decision

The target is an entire repeated document load and application boot, rather than microseconds of driver dispatch. A multi-page checkout returning to a large catalog can have a large opportunity. First `goto`, reloads and same-document SPA navigation receive no such benefit.

Later compare normal navigation with actual cache hits and misses on a controlled multi-page application. Verify restored state, events, navigation promises and cross-test eviction, including a deliberately ineligible page. A flag-only speed measurement is insufficient if the driver waits incorrectly or loses events.

Run history/navigation/frame and context-reset coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src` in normal mode, plus a dedicated native-history corpus. Report opt-in results separately beside the full [benchmark matrix](../bench/README.md) and current-fork controls under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No experiments now.
