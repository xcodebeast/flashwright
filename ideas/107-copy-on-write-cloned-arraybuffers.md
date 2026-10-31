# Clone large ArrayBuffers by copying pages only when they change

Scope: browser apps that repeatedly send large binary data to workers without transferring ownership. Effort: monumental V8, Blink and memory-manager work. Potential: remove eager copies while preserving independent mutable buffers.

Research, 2026-10-31, against local worker/evaluation paths and current public engine sources. No memory mapping experiments or workers started. External engine details require matching to the packaged browser revision.

## Evidence and distinction

V8's [`ValueSerializer::WriteJSArrayBuffer`](https://raw.githubusercontent.com/v8/v8/main/src/objects/value-serializer.cc) has separate shared, transferred and immutable-buffer cases. Ordinary mutable buffers still reach `WriteRawBytes`. Its immutable-buffer sharing path is already present in current source, so adding immutable sharing alone would not be new.

The [HTML structured-data contract](https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal) requires clone independence. Replacing an ordinary clone with a transfer would detach the sender; replacing it with shared memory would expose writes. Both change the application.

[Idea 24](24-packed-evaluation-values.md) changes Playwright's Node/browser value codec. This proposal targets the application's own `postMessage` and `structuredClone`, below that codec. [Idea 98](98-checkpointed-browser-fixtures.md) clones an entire prepared page; no page checkpoint or fixture API is needed here.

## Proposed change

Add an eligible backing-store type for large, fixed-length, ordinary ArrayBuffers. At the precise point the serializer visits the buffer, establish an immutable snapshot of its physical pages. Give sender and receiver private mappings initially backed by that snapshot. Their first write to a page obtains a private copy; neither sees the other's changes.

The difficult part is snapshotting an already mutable backing store. Ordinary `MAP_PRIVATE` mappings of an existing file do not magically capture anonymous memory and all prior private writes. A prototype may need one initial copy into immutable backing storage, with savings only on subsequent fan-out clones. A full version needs runtime-owned page versions and safe remapping or write-fault handling. Count that cost honestly.

Start on one OS with same-process dedicated workers and buffers that have no external/native writer. Keep object graph serialization, getters and message scheduling unchanged; replace only the eligible byte-payload operation. Preserve each typed-array view's offset and length and aliasing among views within one clone.

Buffers with externalized pointers, active native writes, shared or resizable backing, unsupported allocation alignment, or Wasm ownership stay on the existing copy path. A size threshold and measured mutation history should prevent page-fault machinery from penalizing small or write-heavy buffers.

## Functional boundary

Snapshot at buffer visitation, not at message delivery or at the end of graph serialization. A later getter in the same serialized object can mutate a buffer already visited. The receiver must retain the earlier bytes.

All stores, including optimized typed-array stores and supported native consumers, must trigger correct separation. Preserve detach/transfer behavior, DataCloneError timing, identity relationships, termination and memory accounting. No application-level Proxy can enforce this over raw typed-array writes.

If the runtime cannot guarantee write isolation and snapshot timing, this is not a shippable optimization. Keep ordinary copying available through a negotiated browser feature and disable switch.

## Payoff and later decision

Read-mostly fan-out of one large dataset offers the strongest case: physical memory and copying can scale with changed pages instead of a full buffer per recipient. Full-buffer writers can lose through faults plus eventual copying. The first clone may gain nothing.

Later compare many read-only receivers, sparse writes, full rewrites, mutation during serialization and mixed native/JS access. Run structured-clone web-platform coverage, worker/evaluation tests and the [full matrix/upstream procedure](01-browser-native-actions.md#payoff-and-decision-test). Include initial snapshot creation, page-table work, faults, cleanup and proportional shared-memory accounting.

**Assessed 2026-10-31:** deferred: browser-internal (V8, Blink and the memory manager), needs a custom Chromium; no measured test workload clones large ArrayBuffers repeatedly.
