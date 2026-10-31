# Filter browser cookies before sending them to Node

Scope: `context.request`, `page.request` and URL-filtered `context.cookies()` with large browser cookie jars. Effort: large; a complete solution needs a browser command. Potential: remove a whole-jar transfer from every API request and redirect.

**Assessed 2026-10-31:** deferred: only API requests through a browser context with many cookies for other hosts.

Research proposal, 2026-10-31. Source inspection only; no benchmarks or browser work performed. Gains below are hypotheses.

## Evidence and distinct opportunity

[`APIRequestContext._updateRequestCookieHeader`](../packages/playwright-core/src/server/fetch.ts) asks for cookies before sending a request unless a Cookie header was supplied. `BrowserContextAPIRequestContext.cookies` delegates to the browser context. Chromium's [`doGetCookies`](../packages/playwright-core/src/server/chromium/crBrowser.ts) calls `Storage.getCookies` for the **entire context**, converts every returned cookie, then calls [`network.filterCookies`](../packages/playwright-core/src/server/network.ts) with the requested URLs. The request layer applies another matching pass.

Thus a request to one host can transfer cookies from hundreds of unrelated hosts. With `R` requests and `C` stored cookies, this path can repeatedly serialize and inspect roughly `R × C` cookie records. Cookie values can make the byte cost much larger than the record count suggests.

[Idea 22](22-indexed-api-cookie-store.md) indexes the separate JavaScript cookie store used by standalone API contexts. It does not change this browser-owned store or eliminate its protocol payload.

## Proposed change

Add a context-scoped browser operation accepting destination URLs and returning only cookies that survive Playwright's existing URL filter. Use the browser cookie store's domain organization to obtain a conservative candidate set, then apply the exact current filter before serialization. Keep the existing Node conversion and request-specific `Cookie.matches` check initially.

The local [protocol schema](../packages/playwright-core/src/server/chromium/protocol.d.ts) already defines URL-aware `Network.getCookies`. Treat that as a limited feasibility path, not a drop-in replacement: it is target-scoped, while a context can have no page, and native inclusion policy may differ. Do not create a temporary page for every lookup or quietly choose an arbitrary page's partition. A private context-level command avoids those dependencies.

Start with one URL and ordinary cookies. Extend to multiple URLs and partitioned cookies after matching ordered results against the old full-jar path. Empty URL lists still enumerate everything. Unsupported browsers and ambiguous cases retain the existing operation. No Node-side mirror is needed, so there is no new cookie invalidation protocol.

## Compatibility boundary

Preserve expiration, host-only handling, leading-dot domains, path-prefix behavior, localhost's secure-cookie exception, SameSite defaults, partition keys and result order. The current public filter is not identical to the browser's rules for attaching cookies to an actual navigation. Applying a stricter native policy could silently omit cookies.

Run the query on the same cookie-store sequence as writes. Calls after `addCookies`, `clearCookies`, response Set-Cookie processing and context reset must see the same state as today. Do not cache a result across requests or suppress browser storage isolation. Negotiate the command and retain an ordinary-protocol fallback.

## Payoff and later decision

The useful workload is many short requests with `C` much larger than the matching subset. The intended gain is less browser serialization, pipe traffic, Node allocation and filtering. Empty jars and requests dominated by network latency have little upside.

Later compare small and large jars, long cookie values, redirects, concurrent cookie mutations and contexts without pages. Require exact ordered-cookie and outgoing-header equality. Use APIRequest/cookie library coverage, `tests/page` on `chromium-page`, and `tests/playwright-test`; compare failures with pristine upstream in `workbench/pw-src`. Follow the [full matrix and current-fork comparison procedure](01-browser-native-actions.md#payoff-and-decision-test), including CPU and memory. Reject the browser extension if the full request path does not improve. Build and measure only when separate capacity is available.
