# Carry large worker output outside JSON control messages

Scope: tests that emit substantial stdout/stderr, especially binary chunks and many concurrent workers. Effort: large. Potential: reduce serialization CPU, transient copies and control-channel congestion without dropping logs.

**Assessed 2026-10-31:** deferred: only tests that print a lot of output.

Research, 2026-10-31. Source and Node documentation only. No workers or output-generation experiments started.

## Evidence and difference from existing ideas

[`WorkerMain._writeStdio`](../packages/playwright/src/worker/workerMain.ts) sends output as worker events. [`stdioChunkToParams`](../packages/playwright/src/common/ipc.ts) copies a Uint8Array into a Buffer and base64-encodes it; strings become text fields. [`ProcessHost`](../packages/playwright/src/runner/processHost.ts) forks workers with Node's default JSON IPC serialization. Output therefore shares serialized traffic with steps, test completion and control messages.

The parent decodes chunks and retains them in each result's stdout/stderr arrays. Browser console messages are a different path. [Idea 26](26-compact-worker-step-events.md) compresses step metadata; this changes bulk process-output transport and leaves the step schema intact.

## Proposed change

Add an optional binary output pipe to each physical worker process. Frame each large output chunk with lane identity, stream kind, logical sequence number, representation kind and byte length. Send bytes directly, without base64 or JSON escaping. Keep small chunks on the existing path initially.

Assign sequence numbers at the shared event-dispatch boundary to both output and control events. The parent merges them before invoking public reporter callbacks, preserving their logical order. Internal transport handling can remain responsive, but a public `testEnd` must not overtake preceding output.

Preserve chunk boundaries and string-versus-Buffer identity. String payloads need a lossless code-unit representation, such as UTF-16LE, where UTF-8 would replace lone surrogates. Binary payloads must be captured before the user's write returns: retaining a mutable Buffer until a later asynchronous send is not equivalent to today's immediate encoding.

Negotiate support when workers start, including standby/session workers and shared-process lanes. Keep the existing IPC transport for incompatible peers. Use bounded additional pipe staging; on saturation, an ordered fallback can use the old encoded-message path rather than silently growing a second unbounded queue.

As a smaller comparison, evaluate [Node's advanced IPC serialization](https://raw.githubusercontent.com/nodejs/node/v22.x/doc/api/child_process.md#advanced-serialization). It can carry Buffers, but changes serialization semantics and is not automatically faster. A blanket switch for every message requires a separate compatibility audit.

## Compatibility boundary

Preserve stdout/stderr callbacks, their original chunks, trace output, test attribution and late output from failed workers. Keep today's `write()` return and callback scheduling semantics; adding new backpressure visible to test code would be a separate behavior change.

Do not merge chunks exposed to custom reporters or bypass their callbacks. On worker death, drain complete frames and apply the established exit/error behavior to an incomplete tail. A missing sequence must not hang reporting forever. Mixed native fd writes and intercepted JavaScript writes also need their current handling.

Results still retain complete logs, and a producer that ignores all flow control can still consume memory. This proposal reduces intermediate copies and encoding; it does not claim bounded total log memory or discard output to gain speed.

## Payoff and later decision

Large binary chunks avoid base64 expansion and JSON string copies; a copy to capture mutable input can still be necessary. Large text avoids JSON escape/parse work. Small human-readable logs may gain little and can become slower if every chunk needs extra framing. Separate output transport is useful only if the ordering merger does not erase its savings.

Later compare complete log-heavy runs with text, Unicode, binary output, mutable input Buffers and abrupt worker exit. Compare reporter event/chunk sequences exactly and include tracing, shared lanes and warm sessions. Measure wall time, serialization CPU and peak memory, including final output drain.

Run [`stdio.spec.ts`](../tests/playwright-test/stdio.spec.ts), reporter/retry tests and the [full matrix and upstream regression procedure](01-browser-native-actions.md#payoff-and-decision-test), with current-fork controls and output-heavy rows. Defer execution until this machine is free.
