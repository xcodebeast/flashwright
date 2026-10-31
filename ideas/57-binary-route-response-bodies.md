# Deliver large fulfilled responses through a browser data pipe

Scope: large mocked responses and `route.fetch()` followed by `route.fulfill({ response })`. Effort: very large for browser integration. Priority: high potential for payload-heavy mocked applications.

**Assessed 2026-10-31:** deferred: only large mocked responses, and it needs browser changes.

Research, 2026-10-31, against `95f3e831` and the live worktree. No response transfers or browser builds performed.

## Evidence and distinct opportunity

[`Route.fulfill`](../packages/playwright-core/src/server/network.ts) already accepts `fetchResponseUid`, so a response fetched by the server need not return to the test client first. However, it turns the referenced Buffer into a base64 string. [`RouteImpl.fulfill`](../packages/playwright-core/src/server/chromium/crNetworkManager.ts) sends the body through `Fetch.fulfillRequest`; non-base64 bodies are encoded there. The [current JSON CDP interface](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#method-fulfillRequest) carries response bytes as base64.

Thus a large response can coexist as a Buffer, expanded base64 text and serialized protocol text before the browser reconstructs its bytes. [Idea 16](16-segmented-api-request-bodies.md) changes Node body assembly; [idea 15](15-binary-browser-protocol.md) changes general protocol encoding. This proposal removes the full-body control-message representation and feeds the network response through a separate bounded byte channel.

## Proposed change

Introduce a version-negotiated browser command that references a response-body lease. The lease identifies an immutable byte source, length and lifetime. Send response status and headers through the ordinary control channel, then connect the byte source to the browser's normal fulfilled-response loader.

For a local driver, use shared read-only memory or an OS-backed byte pipe with bounded flow control. For remote drivers, the existing client-to-server upload remains; the optimization starts at the server-to-browser boundary. A server-owned APIResponse Buffer can supply the lease directly without first generating base64. Keep the simple path for small bodies.

Preserve the current readiness boundary. `route.fetch()` still finishes downloading/decompressing before returning. A path passed to fulfill must be captured at the same point as today. Do not make a slow or mutable file visible to the page before its full contents are available merely because the new pipe supports streaming.

Tie each lease to one routed request and context generation. Release it only after the browser has consumed or rejected it. Cancellation, navigation and browser death revoke the transfer. Acknowledgements must distinguish accepted metadata, consumed bytes and completed fulfillment so buffers are never recycled early.

## Compatibility boundary

Preserve status/reason mapping, duplicate and Set-Cookie headers, automatic CORS headers, body bytes, response-body overrides and request event order. Do not replace fulfillment with a localhost redirect or a synthetic page fetch: those change origin, service-worker, CSP and network observations.

Public Buffers must remain ordinary mutable Buffers. Snapshot or otherwise protect the bytes for the transfer; borrowing user memory while another task can modify it is unsafe. Explicit APIResponse disposal and cross-context response references must retain existing success/error behavior. Memory ownership is part of the design, not an optional cleanup detail.

Old browsers, remote CDP connections and unsupported platforms use the existing command. Compare with CBOR transport if available: if it already removes enough base64 work, an additional data-pipe protocol may not repay its maintenance cost. Keep browser patches narrow and separately disableable.

## Payoff and later decision

Base64 represents three input bytes with four characters before string/JSON overhead. Avoiding that expansion and repeated copies can lower both response latency and peak memory for tens or hundreds of megabytes. It cannot remove the original HTTP download, decompression or browser consumption. Small fixtures may be slower because lease setup dominates.

Later compare current JSON, any available binary CDP path and leased bodies on large text/binary responses. Verify exact browser-visible bytes, headers, concurrent fulfillments, disposal races and aborted transfers. Measure complete routed page readiness, driver/browser CPU and total resident memory.

Build on separate capacity. Run routing/APIRequest/network coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report payload-heavy rows plus the full [matrix](../bench/README.md) under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No execution now.
