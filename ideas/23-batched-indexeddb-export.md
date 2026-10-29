# Export IndexedDB records in batches instead of one request per record

**Scope:** storageState capture for offline applications and large authenticated datasets. **Effort:** medium. **Priority:** high for IndexedDB-heavy setup projects.

Research proposal, 2026-10-29. No performance measurements. This optimizes explicit storage export; [context reset epochs](02-context-reset-epochs.md) concern isolation between tests and do not eliminate this read path.

## Evidence

[`StorageScript._collectDB`](../packages/injected/src/storageScript.ts) creates a readonly transaction across the database's stores. For each store it reads all keys, then issues one `objectStore.get(key)` per record, wrapping each request with success/error listeners and a Promise. `Promise.all` overlaps work but still creates and delivers every individual request.

The [IndexedDB specification](https://www.w3.org/TR/IndexedDB/#dom-idbobjectstore-getallrecords) defines bulk `getAll`, `getAllKeys` and `getAllRecords` operations. Availability must be checked against each bundled browser; the newer method must not be assumed universal.

## Design

Begin with `getAllKeys()` and `getAll()` queued together in the existing readonly transaction. Both enumerate the same object store in key order. Pair their results, retaining the existing `_trySerialize` representation, schema/index metadata and record order. This replaces `N + 1` requests with two per store without changing the public JSON format.

For large stores, use bounded key-range batches, preferably `getAllRecords` where supported. Issue the next request while the transaction is active; do not yield to unrelated tasks or begin a new transaction between batches. A series of independent transactions could observe writes that the original single transaction would exclude. If portable transaction-lifetime handling cannot preserve that boundary, keep the two-request version rather than inventing a weak snapshot.

Batching limits temporary key/value/request objects, but the final storageState object still holds all exported records. Do not claim constant total memory. Avoid adding a separate serializer rewrite to the first patch; isolate gains from fewer IndexedDB events.

## Compatibility and payoff

Preserve key ordering, out-of-line keys, compound keys, empty stores, autoIncrement/index metadata, encoded values, cycles and errors. Keep one readonly transaction over the original set of stores, database closing and concurrent deletion/version-change behavior. Verify Firefox utility-world restrictions and WebKit separately. Unsupported cases retain the current reader.

The opportunity is removal of per-record asynchronous dispatch and Promise/listener overhead, not faster disk hardware or skipped data. It can shorten setup-project critical paths and repeated snapshots by a large fraction when thousands of records are present. Tiny authentication stores may see little benefit; bulk reads can increase transient value memory unless batching is carefully implemented.

## Later decision test

First compare exported objects and a restore/read round trip for mixed keys, typed arrays, Dates, Maps/Sets and concurrent writers. Measure snapshot completion, request count, CPU and peak browser/Node memory across record counts and sizes. Include the caller's file write in end-to-end timing.

Later run [`browsercontext-storage-state.spec.ts`](../tests/library/browsercontext-storage-state.spec.ts), storage API coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and `node bench/matrix.mjs`, with large-state additions and current-fork comparisons under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Do not run them now.
