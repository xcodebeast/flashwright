# Build IndexedDB indexes beside the stored records

Scope: offline applications and migration tests that add indexes to populated IndexedDB stores. Effort: very large Chromium storage work. Potential: eliminate record transfer and renderer object reconstruction during index creation.

Research, 2026-10-31, against `913231d4` and Chromium main. The [browser manifest](../packages/playwright-core/browsers.json) pins a separate build; reconcile external source with that revision before implementation. No database opened or migration run.

## Evidence and distinction

Chromium's [`IndexPopulator`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/indexeddb/idb_object_store.cc) opens an internal cursor over existing values, obtains each value in the renderer, generates its index keys and calls `SetIndexKeys`. The [`IndexedDB Mojo interface`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/public/mojom/indexeddb/indexeddb.mojom) explicitly describes this per-record return trip. Cursor prefetching can reduce transport exchanges, but does not remove renderer-side value reconstruction and key generation.

This is an application `createIndex()` path, not Playwright's storage export. [Idea 23](23-batched-indexeddb-export.md) batches exported records; [idea 44](44-storage-state-without-origin-navigation.md) changes state restoration. Neither builds an index over an existing populated store inside the storage service.

The [local storage restore code](../packages/injected/src/storageScript.ts) creates indexes before inserting restored records. That empty-store case is not the main beneficiary. The target is later application upgrades, imported datasets followed by index creation, and database migration suites.

## Proposed change

Send an index-build descriptor to the storage service: transaction/store identity, key path, uniqueness and multi-entry rules. Scan the transaction's existing records beside the backing store, extract keys and insert index entries there. Return progress/completion or the same failure, without sending whole values to the page.

Start with supported serialized plain objects and simple property key paths. Implement a versioned structured-clone reader that can skip unrelated fields while resolving required references. Preserve shared references and cycles in the serialized graph; searching raw bytes for a property name is incorrect. Use the existing engine key-extraction implementation as the semantic reference.

For unsupported value tags or key paths, retain the renderer path. Eligibility must be known before publishing an incompatible index result; mixed execution needs transaction checkpoints or a safe per-record fallback. Blob/File metadata, special key-path properties and compound keys deserve explicit support rather than guessed decoding.

For several indexes created at the same safe transaction stage, a later extension could extract their keys in one scan. Do not reorder schema operations merely to obtain this batching. Keep the first version to one index so its benefit is attributable.

## Functional boundary

Preserve upgrade-transaction ordering, reads/writes queued around index creation, duplicate-key failures, missing/invalid keys, multi-entry deduplication and full rollback. The [IndexedDB transaction contract](https://w3c.github.io/IndexedDB/#upgrade-transaction) remains authoritative. A failed unique index must not leave a partially usable index or accidentally commit unrelated work.

Keep durability, quotas, origin isolation, blocked/versionchange events and abort behavior unchanged. Do not weaken disk guarantees or replace storage with an in-memory mock. Bound scan buffers and keep cancellation responsive.

## Payoff and later decision

The removable work scales with record payloads currently transferred and deserialized. Large records with a small indexed field offer the strongest case; tiny stores or already-native paths may not justify the complexity. Storage reads and actual index writes remain.

Later compare large populated-store upgrades with empty-store controls, multiple indexes, unique conflicts, exotic values, aborts and subsequent queries. Require identical database contents, errors and event order. Run IndexedDB web-platform tests, relevant library/page tests and the [full matrix/upstream comparison](01-browser-native-actions.md#payoff-and-decision-test). Count storage-service CPU and buffers, not just reduced renderer time. Build and validate on separate capacity.

**Assessed 2026-10-31:** deferred: browser-internal (Chromium storage service), needs a custom Chromium; only migration tests that index populated IndexedDB stores benefit.
