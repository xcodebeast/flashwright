# Compile route matching once, then search only plausible handlers

**Scope:** heavily mocked applications with many ordinary JavaScript routes. **Effort:** medium for compilation, large for indexing. **Priority:** high for route-heavy suites.

**Status:** compilation implemented (`ae8dc648`): globs are turned into regular expressions once per base URL and glob, on the client and in the server's request interception; 60 requests against 10 globs take 0.035 ms instead of 0.42 ms. Indexing handlers is not done.

Research proposal, 2026-10-29, based on `1aebba9e` plus the active worktree. No benchmarks or implementation. Unlike [browser-local HAR routing](06-browser-local-har-routing.md), this optimizes selection of ordinary user callbacks in Node; it needs no HAR or browser patch.

## Evidence

[`RouteHandler`](../packages/playwright-core/src/client/network.ts) validates string globs during construction but does not retain the compiled matcher. Its `matches()` calls [`urlMatches`](../packages/isomorphic/urlMatch.ts), which resolves the base URL, translates the glob and constructs a RegExp again. [`Page._onRoute`](../packages/playwright-core/src/client/page.ts) and [`BrowserContext._onRoute`](../packages/playwright-core/src/client/browserContext.ts) copy and scan the route list for every request, then use `indexOf` to check that a matching handler remains registered.

For `R` requests and `H` handlers, selection can perform `R × H` pattern preparations and tests. Handler fallback can add repeated membership scans. Large mock registries pay this before their response can proceed.

## Design

First retain the resolved RegExp for string patterns in each handler. Base URL and string pattern are fixed at registration. Preserve the original URL object for `unroute` equality and interception serialization. Keep user-supplied RegExp, URLPattern and function predicates on their exact existing behavior.

Then build a candidate index for **string patterns only**. Use conservatively extracted literal origin/path prefixes to reject impossible handlers; ambiguous globs remain in a catch-all bucket. Merge candidate buckets in reverse registration order. Retain generation/membership records so removal checks do not scan the entire registry.

Function predicates are executable user code: even a false result may have side effects. Always visit them in their original position. Likewise, do not pre-evaluate later handlers before an earlier handler has fallen back. A route registration/removal while a callback awaits must have the same effect as the current snapshot-plus-live-membership algorithm. Do not replace all matching with one combined regex: its backtracking and precedence can differ substantially.

## Compatibility and payoff

Preserve page-before-context priority, `times`, fallback URL changes, registration validation errors, redirects, `unrouteAll`, exceptions and close behavior. String compilation is the first independent patch; indexed dispatch should remain separately disableable until differential coverage is strong. No intended public behavior difference.

Target work becomes one compilation per registration, then candidate matching per request. Small route lists may only benefit from compilation; broad catch-all registries still require linear scanning. An index that costs more to update than it saves should stay disabled for small/churning registries.

## Later decision test

Compare ordered callback invocations and request outcomes against the existing dispatcher for overlapping globs, functions with side effects, regex state, fallback and concurrent removal. Measure registration plus full routed-page load time for small and large registries; count allocation and CPU, not just regex throughput.

When the machine is available, run routing/unroute library coverage, `tests/page` on `chromium-page` and `tests/playwright-test`, comparing failures with pristine upstream in `workbench/pw-src`. Report `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and the entire `node bench/matrix.mjs`, with a current-fork baseline and route-heavy additions. Follow the [shared evaluation rules](01-browser-native-actions.md#payoff-and-decision-test); do not benchmark now.
