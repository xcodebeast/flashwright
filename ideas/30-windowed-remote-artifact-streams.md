# Stream remote artifacts with a bounded receive window

**Scope:** remote browsers and large downloads, videos or other artifacts saved to the client. **Effort:** large. **Priority:** high on high-latency connections; low for local runs.

Research proposal, 2026-10-29. No measurements. This targets Playwright client/server artifact transfer, not the [browser's CDP encoding](15-binary-browser-protocol.md), video capture or report generation.

## Evidence

[`ReadableStreamImpl._read`](../packages/playwright-core/src/client/stream.ts) awaits one channel `read({ size: 1024 * 1024 })` before pushing data. [`StreamDispatcher.read`](../packages/playwright-core/src/server/dispatchers/streamDispatcher.ts) returns at most that amount, and may return much less: it reads the minimum of available buffered bytes and the requested size. The one-megabyte argument is not a guarantee of one-megabyte chunks.

[`Artifact.saveAs`](../packages/playwright-core/src/client/artifact.ts) uses this stream for remote connections. Each replenishment therefore requires another client/server request-response cycle. Local saveAs already uses a different path and should not be credited with these gains.

## Design

Add a negotiated streaming channel with byte credits. Once the caller requests data, grant a bounded receive window; the server sends ordered chunks until credit is exhausted. The client replenishes credit as the consumer drains, allowing transfer to continue without a round trip after every chunk. Use explicit stream IDs, offsets/sequences, terminal success/error and cancellation records.

Keep artifact readiness unchanged: this proposal does not expose unfinished videos or downloads earlier. Open the existing artifact stream at the same lifecycle point, then optimize its transfer. Start with the current binary-field encoding so flow-control gains can be isolated; a binary side channel is a separate later experiment.

Use per-stream and per-connection budgets, fair chunk scheduling and priority for control messages. One large video must not block a page action, cancellation or another worker's small artifact. Size the window against observed throughput/latency within a hard cap; never buffer an entire arbitrary artifact to avoid flow-control complexity.

## Compatibility and payoff

Honor [Node readable-stream backpressure](https://nodejs.org/docs/latest-v22.x/api/stream.html#readablereadsize), pause/resume, destruction, error propagation and EOF. Preserve save/delete/context-close lifetimes and ensure a completed save contains every byte. Disconnection cannot be mistaken for successful EOF. Cancellation revokes future credit and releases server descriptors and buffers.

Keep the pull protocol for old clients/servers and unsupported transports. Do not run concurrent calls to the current `StreamDispatcher.read` as a shortcut: multiple waiters and stream.read ownership need explicit serialization. Transparent reconnection/resume is outside the first version; offsets alone do not prove the same immutable artifact is still available.

With effective chunk size `C` and round-trip time `r`, sequential refill can impose a throughput ceiling near `C/r` before encoding, disk and bandwidth costs. Windowing changes that component toward `W/r`, where `W` is outstanding credit. These are explanatory limits, not measured rates. Larger windows cost memory, and localhost may see little improvement.

## Later decision test

Compare saved bytes and terminal outcomes for small/large artifacts, short reads, slow destinations, paused consumers, simultaneous streams, failures and context closure. Measure complete save time and action latency during transfers, along with peak buffered bytes; all queues must remain bounded.

Later run remote-download/artifact/video library coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Add remote-latency cases beside `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and the entire `node bench/matrix.mjs`, including the current-fork pull-stream baseline under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Do not run transfers or network emulation now.
