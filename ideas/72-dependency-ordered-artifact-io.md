# Order each recording's artifact writes by dependency

Scope: traces and HAR recordings with many resource files or sustained event output. Effort: large. Priority: promising when artifact I/O falls behind producers.

**Assessed 2026-10-31:** deferred: only artifact-heavy recordings.

Research, 2026-10-31, against `2bc2768b` plus the live worktree. No files generated, I/O probes or measurements.

## Evidence and opportunity

Each [`SerializedFS`](../packages/utils/serializedFS.ts) instance uses one `_operations` queue. `_performOperations` awaits each mkdir, write, copy, append or ZIP operation before starting the next. Appends already accumulate into roughly 64 KiB chunks, so ordinary batching is present. Each flushed append still calls `fs.promises.appendFile` by path, and independent resource writes within that instance share the same serial queue.

The producers include [`Tracing`](../packages/playwright-core/src/server/trace/recorder/tracing.ts) and [`HarRecorder`](../packages/playwright-core/src/server/har/harRecorder.ts). A busy artifact writer can retain queued strings/Buffers and extend final `sync()` even when unrelated files could be written concurrently.

[Idea 07](07-incremental-trace-recording.md) changes capture and processing; [idea 55](55-trace-archive-compressed-splicing.md) removes an archive codec cycle; [idea 67](67-spool-completed-har-records.md) releases HAR objects earlier. This proposal changes the shared filesystem executor beneath those producers.

## Proposed change

Start with a bounded append writer for private recording files. Retain an open descriptor, track buffered byte counts directly, and write ordered batches without reopening the path for every chunk. Preserve overwrite, flush and close boundaries. Use a head-index queue or deque so queue bookkeeping stays cheap under sustained backlog.

Then replace unnecessary cross-file ordering with explicit dependencies: directory creation before its files, FIFO operations on the same file, copy reads after source completion, and ZIP/export after every referenced file is ready. Admit a small number of independent immutable resource writes concurrently.

A trace event that references a resource may need an edge from that resource's publication, especially for live viewers. Do not assume two different paths are always independent. Start with private export-only resources; keep live or externally visible output on the existing ordering until its visibility contract is established.

Use one byte and descriptor budget across active writers. Cap concurrency rather than giving every test an unlimited pool. Backpressure must reach producers at safe await points; a synchronous enqueue API cannot bound memory by itself. Never block the event loop while waiting for disk or drop records to keep it fast.

## Compatibility boundary

Preserve per-file bytes, overwrite and skip-if-exists behavior, ZIP membership, required visibility order and `sync()` completion. An open descriptor can outlive a renamed path, so path replacement requires explicit ownership or the old path-based writer.

Concurrent writes change failure behavior: later operations may already have started when an earlier one fails. Limit them to private resources that can be discarded on failure, stop admission, settle started work, and report a stable error. Public/live sinks that require today's stop-before-later-effects behavior retain serialization. Clean up descriptors and staging on every cancellation path.

## Payoff and later decision

The target is repeated file-open overhead, independent I/O serialized behind one another, and producer backlog. No capture, compression or required byte is removed. More concurrency can slow metadata-bound disks or compete with test imports; persistent handles alone may be the better result.

Later compare full trace/HAR stop and run completion across few large files, many tiny resources, slow disks and saturated writers. Check exact extracted artifacts, live viewing, overwrite ordering and injected I/O failures. Run trace/HAR/runner artifact coverage and upstream page/runner suites against pristine upstream. Report the full [matrix](../bench/README.md), current-fork controls and artifact-heavy rows under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Count all queued memory, open files and final drains. No experiments now.
