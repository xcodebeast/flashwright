# Serve HAR routes beside the browser network stack

**Priority:** high for heavily mocked suites · **Scope:** HAR replay and declarative request rules · **Effort:** medium for indexing, very large for the browser path.

Research proposal, 2026-10-29. No new benchmarks. This accelerates mocks a test already requests; it does not replace real backend traffic with replay.

## Remaining cost

[`HarRouter._handle`](../packages/playwright-core/src/client/harRouter.ts) receives each routed request in the client, obtains headers, calls server-side `harLookup`, then fulfills, redirects, aborts or falls back through the client again. [`HarBackend._harFindResponse`](../packages/playwright-core/src/server/harBackend.ts) scans the HAR entry list for each lookup and may load body data while matching. This creates an algorithmic cost as recordings grow, in addition to client/server exchanges.

[`CRNetworkManager._updateProtocolRequestInterceptionForSession`](../packages/playwright-core/src/server/chromium/crNetworkManager.ts) enables a wildcard Fetch request-stage pattern when user routing or credentials require interception. Unmatched traffic can therefore enter the interception machinery too. The [Fetch protocol schema](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Fetch.pdl) specifies that matching requests remain paused until a continuation, fulfillment or failure command arrives. Request-critical delays can accumulate before scripts and API responses become available.

## Proposed mechanism

Compile each immutable HAR into a bounded replay table, indexed first by URL and method, with body/header discriminators preserving the current matching and tie-breaking rules. Decode/cache response bodies lazily with a byte budget. A content-identified HAR can share its immutable table across tests; matching state, cookies and route state remain private.

First move the built-in HAR handler to the server so lookup and fulfillment need no return to the JavaScript client. This can use stock Chromium and establishes the gain from indexing and removing one layer. Preserve route registration precedence and fall back to client callbacks wherever they can participate.

Then consider a Chromium network-service extension that installs the table once and serves eligible requests locally. Pass response bodies through shared immutable storage rather than base64 per response. Keep emitting the request/response events required by Playwright. Arbitrary JavaScript callbacks and function/regex URL predicates stay in Node; do not execute or infer user callbacks ahead of time.

For ordinary routes, conservatively narrow Fetch patterns when registration supplies statically understood URL patterns. The browser filter must be a **superset** of actual matches, or it can silently skip a handler. Credentials/authentication may independently require broader interception.

## Functional contract

Preserve page-versus-context priority, reverse registration order, `times`, fallback chains, unroute behavior, redirects, POST/multipart matching, response headers/cookies, misses, stalled HAR entries and canceled requests. Preserve cache-disabled behavior while routing. Service workers, popups, request listeners and dynamic route changes need explicit handling; unsupported cases use the existing path. An update/acknowledgement barrier must ensure an awaited route registration or removal takes effect before the next request.

## Payoff and decision test

**First experiment:** add a URL/method bucket index inside `HarBackend`, retaining the original candidate order and body/header matching. Differentially compare every lookup with the linear implementation, including redirects and multipart bodies. Measure index construction and peak memory as well as replay time.

Indexing targets repeated linear scans over large HARs, reducing lookup CPU. Browser-local replay additionally removes critical-path pauses and repeated body copies for mock-heavy applications. Real server latency and user callback time remain. Limit decoded-body memory; serving hundreds of cached responses faster is not useful if it creates unbounded RSS.

Later compare small/large HARs, hundreds of assets, binary bodies, misses/fallback and dynamic route churn, including startup table installation. Add a representative mocked-app row, then follow the [full matrix and old-fork comparison rule](01-browser-native-actions.md#payoff-and-decision-test). Run upstream `tests/page` on `chromium-page`, [`browsercontext-har.spec.ts`](../tests/library/browsercontext-har.spec.ts), routing/unroute/service-worker tests and runner tests if integration changes, against pristine upstream. Retain the native extension only if it beats the simpler indexed server implementation without event or routing regressions.
