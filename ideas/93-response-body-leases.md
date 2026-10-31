# Read each browser response body once, then lease its bytes to consumers

Scope: large responses consumed by tests, HAR and tracing, especially together. Effort: medium for shared retrieval; very large for a browser data pipe. Compatibility: intended to preserve existing APIs.

**Assessed 2026-10-31:** deferred: only responses whose body is read by both a test and a HAR or trace recording.

Research, 2026-10-31, against `1f613889` and the live worktree. Source inspection only; no performance measurements.

## Evidence and distinction

[`Response.internalBody`](../packages/playwright-core/src/server/network.ts) invokes its body callback on each call. Chromium's [`createResponseBodyCallback`](../packages/playwright-core/src/server/chromium/crNetworkManager.ts) requests `Network.getResponseBody`, then converts the returned string into a Buffer. [`HarTracer`](../packages/playwright-core/src/server/har/harTracer.ts) is another caller. Its existing script-body cache already avoids some retrievals, but does not give all consumers shared ownership of each response's bytes.

The [CDP body API](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-getResponseBody) returns a string plus a base64 flag. Large binary bodies therefore cross the browser boundary in an expanded representation. [Idea 57](57-binary-route-response-bodies.md) moves mocked bodies into the browser. This proposal retrieves actual response bodies in the opposite direction and shares them among consumers. [Idea 67](67-spool-completed-har-records.md) releases finished HAR records; it does not change body retrieval.

## Design

Introduce a response-owned immutable body lease. Concurrent eligible consumers join one retrieval and acquire separate references to its result. Internal HAR and trace consumers can read the same bytes. Public `body()` calls still receive ordinary mutable Buffers with the existing ownership behavior; a caller's mutation must never corrupt another caller or an artifact.

Begin with overlapping reads while the originating document/session remains valid. Add explicit invalidation before extending reuse to sequential reads. Do not retain rejected promises indefinitely or turn a later unavailable-body error into success merely because an earlier consumer read the body.

The larger version gives a compatible browser a binary body-export operation. After the normal completion barrier, it leases existing decoded body storage through a bounded data pipe or read-only shared region. Small bodies retain the current path. Node releases the lease after all internal consumers finish; public Buffer copies remain where required. This eliminates string/base64 materialization without promising zero copies everywhere.

## Functional boundary

Keep redirect errors, fulfilled-response overrides, body decoding, page-closure races and cancellation. A canceled reader must not cancel another reader's lease. Preserve the current restricted refetch fallback when a browser returns an empty body; do not refetch arbitrary application requests to populate a cache.

Browser storage ownership must survive only as long as the current API allows. Durable CDP body storage is not permission to change navigation behavior. Bound retained bytes across the worker, release on reset, and let new reads use the ordinary path when the budget is exhausted. Negotiate the browser extension; stock browsers retain string transport.

## Payoff and later decision

For `C` consumers of an `S`-byte body, the target is one browser extraction instead of up to `C`, followed by fewer full-size intermediate representations. Public copies and the original download remain. The large ceiling is in payload-heavy recorded suites; tiny JSON responses may gain nothing.

Later compare test-only, HAR-only and combined consumers, including concurrent cancellation and navigation. Measure complete download/read/artifact completion, peak browser plus Node memory, and retrieved bytes. Use the [full matrix and current-fork comparison](01-browser-native-actions.md#payoff-and-decision-test), API/network/HAR/tracing suites, `tests/page` on `chromium-page`, and relevant `tests/playwright-test` coverage against pristine upstream. No experiments while the host is busy.
