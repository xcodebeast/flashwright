# Use Chromium's binary DevTools pipe

**Scope:** protocol-heavy local Chromium runs and large protocol payloads. **Effort:** medium to large. **Priority:** high-value feasibility check before inventing a new transport.

Research proposal, 2026-10-29. No runtime probe or speed measurement. This targets Node-to-browser encoding, independently of [in-process client/server dispatch](03-generated-in-process-dispatch.md).

## Evidence and opportunity

[`PipeTransport`](../packages/playwright-core/src/server/pipeTransport.ts) stringifies requests with a null terminator, turns received buffers into strings, and parses JSON. Flashwright already combines each outgoing JSON message into one write. The remaining cost includes serialization, string allocation and payload conversion, not an extra write that still needs fixing.

Chromium's [DevToolsPipeHandler](https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/devtools_pipe_handler.cc) already selects a CBOR mode when the remote-debugging-pipe switch value is `cbor`, uses length-bearing envelopes and advertises binary-protocol support. This is evidence of an upstream mechanism, not proof that every bundled Playwright browser revision supports it or that a JavaScript decoder beats V8's JSON parser.

## Design

Add a separate `ConnectionTransport` implementation for Chromium's actual inspector CBOR dialect. Begin with version-pinned supported browser builds and `--remote-debugging-pipe=cbor`. Preserve the current protocol object shape above the adapter, including session IDs, command IDs and protocol errors. Unsupported builds and WebSocket connections keep JSON.

Implement the precise envelope and value semantics, including partial reads, multiple messages per read, strings and numeric types; a generic CBOR package is not sufficient evidence of compatibility. Compare a small generated decoder with an existing compatible implementation before considering a native addon. A native boundary can cost more than it saves for small messages.

First preserve the current asynchronous message scheduling. Treat parsing and queue optimization separately so any speedup is attributable. For schema-declared binary fields, investigate whether the pinned browser supplies native binary values; do not assume every base64 string disappears just because the outer envelope is binary. Normalize values where existing browser delegates expect base64, then optimize selected bulk consumers separately if worth doing.

## Compatibility boundary

Maintain command/event ordering, cancellation, disconnection errors, nested sessions and public CDPSession results. Preserve logging/debug output and malformed-frame handling. Bound frame sizes and buffered bytes without silently dropping messages.

The warm session hands browser pipes between processes through `PipeTransport.release()`. Extend that contract with encoding/version metadata and complete-frame boundaries; a JSON reader must never adopt a binary pipe. Do not retry a possibly executed command through another encoding after a connection failure. Select the transport before commands execute, with a compatibility switch to restore JSON on the next launch.

## Payoff and later validation

Potential savings are fewer string/base64 conversions and lower serialization CPU; command round trips and browser work remain. It may complement [browser-native actions](01-browser-native-actions.md), but those reduce message count and therefore shrink this opportunity. The two gains must not be added naively.

First compare equivalent recorded protocol messages through both codecs, then full live command/event sequences using the exact pinned browser. Measure small-message latency, large payload throughput, allocations and complete runs; reject a codec that only wins on oversized synthetic payloads.

Later run `tests/page` on `chromium-page`, browser/CDPSession/disconnection/handoff coverage and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Include `node bench/run.mjs todomvc 1 15 stock,fork`, `node bench/matrix.mjs 15`, current-fork comparison and payload-heavy cases under the [shared evaluation rules](01-browser-native-actions.md#payoff-and-decision-test).
