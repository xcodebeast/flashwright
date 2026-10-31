# Release completed HAR entries while recording continues

Scope: long network-heavy tests and large embedded-body HAR recordings. Effort: large. Priority: promising for reducing recording memory and close-time latency together.

**Assessed 2026-10-31:** deferred: only long HAR recordings.

Research, 2026-10-31, against `2bc2768b` plus the live worktree. No HAR files produced or processed.

## Evidence and opportunity

[`HarRecorder`](../packages/playwright-core/src/server/har/harRecorder.ts) retains every entry in `_entries`. Its `_flush()` already writes JSON field-by-field and entry-by-entry, avoiding one giant document string. However, this happens at shutdown, after the entire entry graph has accumulated. `onEntryFinished` currently does nothing.

That callback is not yet a safe serialization boundary. In [`HarTracer._onRequestFinished`](../packages/playwright-core/src/server/har/harTracer.ts), body completion can invoke it while separate header, HTTP-version and size barriers still update the entry. WebSocket entries remain mutable as frames arrive. A naive spool attached to that callback would lose data.

[Idea 06](06-browser-local-har-routing.md) accelerates replay lookup. [Idea 20](20-incremental-test-report-generation.md) concerns runner reports. This proposal changes the lifetime of recorded network data before HAR export.

## Proposed change

Give each HAR entry an original sequence number and explicit pending-field accounting. An HTTP entry becomes sealable only after all its metadata/body work has settled under the existing stop and cancellation rules. Freeze and serialize that record once into bounded private storage, then release the recorder's heavy object references.

Keep a compact sequence-to-offset index. At export, write the same ordered HAR entries from the spool, with final page metadata and the existing document fields. Out-of-order completion must not reorder requests. A slow first request must not force every later completed body to remain in memory; bounded staging or indexed spool segments handle that case.

Start with finite HTTP traffic. Keep live WebSocket records mutable initially, or later give them an append-only frame log that reconstructs the same embedded representation. Do not silently switch `content: 'embed'` to attached files. Audit request-attached entry references too: removing an entry from `_entries` alone does not prove that its body can be collected.

## Compatibility boundary

Preserve raw headers/cookies, overrides, redirects, timing, sizes, compression accounting, content bytes and entry order. Late protocol metadata, failed requests and stopping while a request is in flight need the same final values as today. Introduce the new seal signal for HAR recording without changing trace consumers that use the existing delegate.

Private staging must finish before export or context close reports completion. Propagate I/O errors and clean up on cancellation. Bound bytes in queued writes; reducing individual chunk size does not bound a producer's total backlog. Small recordings should retain a cheap in-memory path if spooling loses.

## Payoff and later decision

The target is retained completed entries, GC pressure and serialization concentrated at context close. The final HAR must still be written, and spooling can add a read/write pass. Only keep the change if reduced allocation or overlap makes complete recording faster; lower RSS alone is insufficient if speed worsens.

Later compare exported HAR structures and body bytes against the current recorder under delayed metadata, concurrent requests, WebSockets and early stop. Run HAR/library tests and upstream page/runner suites against pristine upstream. Report the full [matrix](../bench/README.md), current-fork controls and long-recording rows under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test), including spool I/O and final cleanup. No execution now.
