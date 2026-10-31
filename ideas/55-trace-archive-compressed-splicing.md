# Assemble trace archives without decompressing and recompressing their entries

Scope: retained traces with multiple chunks, contexts, sources or large attachments. Effort: large. Priority: strong candidate for reducing trace finalization CPU and latency.

**Assessed 2026-10-31:** deferred: only retained traces; trace finalization was not a measurable share of the benchmark runs.

Research, 2026-10-31, against `95f3e831` and installed ZIP dependencies. No archives generated, decompressed or benchmarked.

## Evidence and distinct opportunity

[`TestTracing.stopIfNeeded`](../packages/playwright/src/worker/testTracing.ts) creates a ZIP containing runner events, sources and attachments, then calls `mergeTraceFiles` with the temporary trace archives. The merge reads entries using `yauzl.openReadStream` and adds them through `yazl.addReadStream`. Those defaults inflate compressed entries and deflate their contents again. A single-input rename fast path already exists.

Installed [yauzl 3.4.0](https://github.com/thejoshwolfe/yauzl/blob/3.4.0/README.md) exposes raw entry reads. [yazl's documented stream writer](https://github.com/thejoshwolfe/yazl#addreadstreamreadstream-metadatapath-options) normally compresses incoming bytes; passing raw DEFLATE bytes with `compress: false` would produce the wrong entry contents. A real precompressed-entry writer is required.

[Idea 07](07-incremental-trace-recording.md) changes capture and recording. [Idea 20](20-incremental-test-report-generation.md) changes report construction. Neither removes this specific archive-to-archive codec cycle at trace finalization.

## Proposed change

Read each input archive's directory, choose surviving entries using the current merge order, then copy their compressed byte ranges into a new archive. Write new local headers and a central directory containing the new offsets. Preserve compression method, uncompressed length and CRC metadata; correctly rebuild data descriptors and ZIP64 fields where required.

Retain the existing name rules: newest `test.trace` wins, trace streams receive their current index prefixes, and duplicate resource names are included once. Renaming an entry changes headers, not its compressed payload. Use bounded streams or positional copies instead of holding whole archives in memory.

Put the writer in a new utility, with a small hook at `mergeTraceFiles`. Limit the first version to the stored/DEFLATE entries produced by the pinned writers. Unsupported methods, encryption or unfamiliar metadata take the existing decode/re-encode path. A later stage can let producers emit precompressed entry records directly, but the first patch should leave capture untouched.

## Compatibility boundary

Preserve every extracted filename and byte, winner selection, viewer behavior, attachment availability and completion timing. The archive itself need not be byte-identical because compressed data and ZIP metadata already vary; document any changed artifact encoding if exposed. Preserve the metadata consumers actually rely on rather than blindly copying offsets from old headers.

Skipping inflation also skips its malformed-DEFLATE and output-length checks. Do not silently weaken corruption handling. Initially retain a streaming validation pass while copying raw compressed data, eliminating recompression alone. Removing that pass requires verified producer ownership and an integrity design covering persisted bytes; a CRC field copied from an untrusted directory is insufficient. Unknown/imported archives keep full validation.

Publish only after all entries and the directory are complete. Keep failure propagation, cleanup and cancellation. Never delete source archives before successful publication or hide finalization after the test's trace attachment becomes available.

## Payoff and later decision

For multi-chunk traces, the target is one removed deflate pass over all retained uncompressed data, and eventually an inflate pass where safe. Already-compressed videos/images may save CPU even when archive size barely changes. Many tiny entries can remain metadata-bound; trace-off and single-archive runs gain nothing.

Later compare extracted manifests/bytes and Trace Viewer behavior for multiple contexts, retries, duplicate resources, sources, empty entries, corrupt streams and ZIP64. Measure complete test teardown and CLI exit, codec CPU, peak buffers and disk traffic. Include the cost of retained validation.

Run tracing/viewer/reporting coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report trace-heavy rows beside the full [matrix](../bench/README.md) and current-fork controls under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No experiments now.
