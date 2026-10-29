# Stop repeatedly assembling large API request bodies

**Scope:** API tests, upload-heavy suites and large mocked responses. **Effort:** large. **Priority:** high for payload-heavy projects; low for tiny JSON requests.

Research proposal, 2026-10-29. No benchmarks. This changes body ownership and assembly in Node; it is separate from browser HAR replay and binary CDP transport.

## Evidence and opportunity

[`readStreamToJson`](../packages/playwright-core/src/client/fetch.ts) reads a multipart file stream completely and concatenates its chunks. [`MultipartFormData.finish`](../packages/playwright-core/src/server/formData.ts) concatenates headers, fields and file buffers again. On responses, [`APIRequestContext._sendRequest`](../packages/playwright-core/src/server/fetch.ts) collects decoded chunks and joins them into a Buffer; `fetchResponses` retains whole bodies until disposal.

[`APIResponse.body`](../packages/playwright-core/src/client/fetch.ts) later retrieves that body. Normal in-process transport already passes raw Buffers, so claiming it base64-encodes every local request would be wrong. The remaining copies are visible in body construction itself, with additional transport costs on remote connections.

## Design

Introduce an internal replayable body object: ordered immutable byte segments, total length and lifetime ownership. Multipart formatting produces header/footer segments around existing file segments. Write those segments through the HTTP request's backpressure-aware stream without assembling one more giant contiguous Buffer. Compute Content-Length from the segments to preserve current framing.

Initially finish consuming source streams before issuing the request, as today. Sending early would change when the server observes traffic and whether a stream error occurs before any request. An incremental local staging representation can avoid concatenation without making that behavioral change. Preserve bytes if the source file changes later; a path reference that rereads the file on retry is not equivalent to the consumed input.

Store response chunks once and materialize a contiguous Buffer only for consumers that require it. Retain full-body download/decompression before resolving `fetch`, preserving today's timeout and completion behavior. Repeated access can reuse the internal materialization subject to the current public mutation/aliasing behavior. Small bodies keep the simple path.

Route fulfillment, request tracing, HAR recording and response assertions need adapters: any of them may require a contiguous body sooner, reducing the gain. A file-backed store is a separate optional extension for extreme bodies; do not trade speed for disk I/O and call it a performance win. Remote streams need explicit ownership, bounded windows and cancellation, not a promise of universal zero-copy transfer.

## Compatibility boundary

Preserve multipart boundaries and field order, content length, binary bytes, compressed-body handling, authentication retries, 307/308 replay, redirect header policy, network errors and disposal. Replay must use the original captured bytes. Do not automatically discard bodies of status-only responses: users can request them later.

Bound segment count as well as byte count; millions of tiny buffers can be worse than one allocation. Clean up canceled requests and failed decompression. Keep public Buffer results and errors unchanged, and retain the existing body implementation as a fallback.

## Payoff and later validation

The goal is less memory bandwidth and GC, especially when large bodies are assembled or retained but never read. Network transfer and application processing still occur. First replace only server multipart concatenation with replayable segments, then separately assess lazy response materialization.

Later measure large uploads/downloads, status-only versus repeated body reads, compression, route fulfillment and parallel requests. Count total CPU, peak RSS and full disposal time. Run APIRequest library, routing and request-fixture suites, `tests/page` on `chromium-page`, and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Add payload workloads alongside `node bench/run.mjs todomvc 1 15 stock,fork` and `node bench/matrix.mjs 15`, including current-fork comparison under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test).
