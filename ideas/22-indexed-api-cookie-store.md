# Make API cookie lookup proportional to matching domains

**Scope:** API suites with large cookie jars, many origins or repeated authentication. **Effort:** medium. **Priority:** high when cookie filtering is material; negligible for empty jars.

Research proposal, 2026-10-29. Source-backed opportunity, not a measured speedup. This changes the standalone APIRequest cookie store, not browser-context storage generations or request-body assembly.

## Evidence

[`GlobalAPIRequestContext.cookies`](../packages/playwright-core/src/server/fetch.ts) calls `filterCookies(this._cookieStore.allCookies(), urls)`. Request construction obtains cookies through `_updateRequestCookieHeader`, including redirect hops. [`CookieStore`](../packages/playwright-core/src/server/cookieStore.ts) indexes by cookie name, but `allCookies()` traverses every name bucket, prunes expiration and allocates an array of all surviving cookies before URL filtering.

Thus a request to one host can inspect the entire multi-origin jar. Existing keep-alive agents do not remove this CPU/allocation cost. Browser-attached API contexts use browser cookies and are a different path; do not claim this optimization automatically improves them.

## Design

Add a request-oriented index keyed by exact host-only domain and domain-cookie suffix. Given a URL, retrieve only eligible domain buckets, then apply the existing secure/path filters. Preserve a stable ordering key reproducing the current name-bucket and within-bucket iteration, including replacement and deletion behavior. Sorting a much smaller candidate set may be sufficient initially.

Keep authoritative cookie ownership in one store; secondary indexes contain references, not duplicate cookie values. Update them atomically on add, replace, filtered removal and expiration. Keep full enumeration for `storageState()` and unfiltered `cookies()`.

Start with expiration checks on candidate buckets. A bounded expiry heap can later remove repeated scans, using versioned entries so replacing a cookie invalidates the old expiry. Avoid a timer per cookie. Wall-clock changes require care: expiration must still be decided with the existing time semantics at lookup, and stale heap entries need compaction.

## Compatibility and payoff

Match existing domain, path, localhost/secure, duplicate-name, session-cookie and expiry behavior exactly. [RFC 6265 section 5.4](https://datatracker.ietf.org/doc/html/rfc6265#section-5.4) describes domain/path selection, but this optimization is not permission to change existing ordering or standards behavior. Preserve raw cookie-header precedence, redirect handling and clear filters. Any future partition-key support must participate in index identity rather than accidentally merging cookies.

The target is replacing whole-jar scans with domain candidates, reducing request preparation and temporary arrays. It can matter greatly for large API workloads while doing almost nothing for ordinary browser interactions. Maintain a cheap small-jar representation if index bookkeeping loses there. No retained request-result cache is needed, so Set-Cookie mutations remain immediately visible.

## Later decision test

Differentially compare cookie arrays and emitted Cookie header bytes across jar mutations, host/domain boundaries, expired replacements, equal names, path edges and time changes. Include many unrelated domains and heavy churn, not only cache-friendly repeated URLs.

Later run [`global-fetch-cookie.spec.ts`](../tests/library/global-fetch-cookie.spec.ts), broader APIRequest/storage-state coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report whole-command time, CPU and RSS with `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and `node bench/matrix.mjs`, adding large-jar cases and a current-fork baseline under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No execution on the busy machine.
