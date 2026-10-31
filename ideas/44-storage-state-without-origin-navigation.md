# Restore storage state without navigating through every origin

Scope: authenticated suites with multiple storage origins or large IndexedDB state, including strict contexts. Effort: large to very large. Priority: high for this workload.

**Assessed 2026-10-31:** partly done. The real cost of a storageState with one localStorage origin was measured: +8.5 ms per recycled Chromium context and +22 ms per reused Firefox tab. Part of it (2 of the 8.5 ms in Chromium, 9 of the 22 ms in Firefox) was the injected script being created in the storage documents, which never use it. `6f14cacc` skips it: 13 -> 11 ms (Chromium) and 32 -> 23 ms (Firefox) per test. Creating the restoring page before the next test's tab, so that restoring overlaps opening the tab, measured slower (13 ms): the first tab created absorbs the browser's busy time. What remains is one intercepted navigation per origin, ~3 ms, which needs browser work: deferred.

Research, 2026-10-31, against `c4c3583b` and the live worktree. No execution or speed measurements.

## Where the work is

[`BrowserContext.setStorageState`](../packages/playwright-core/src/server/browserContext.ts) installs cookies, opens or adopts a temporary page, intercepts its traffic, then navigates that page through the union of old and new origins. At each origin it evaluates an embedded storage script before continuing. Preparing the page early already exists; the sequential origin navigations remain.

[`StorageScript.restore`](../packages/injected/src/storageScript.ts) implements the actual localStorage, IndexedDB and file-state restoration. [Idea 23](23-batched-indexeddb-export.md) addresses record reads during export. [Idea 02](02-context-reset-epochs.md) changes storage ownership between tests. This proposal instead replaces the navigation-based adapter for an explicit storage import, without reusing a baseline or introducing storage generations.

## Proposed change

Add a private browser-context command that imports the existing storageState representation directly through the browser's storage services. Chromium's [StoragePartition implementation](https://chromium.googlesource.com/chromium/src.git/+/master/content/browser/storage_partition_impl.cc) owns DOM storage, IndexedDB and related service interfaces. Those are integration points, not an existing complete import API.

Start with localStorage in a newly created context before any application page is exposed. Resolve each origin to the same storage key the current temporary document would use, perform the writes, and acknowledge only once later documents will observe them. Keep cookie handling unchanged.

Then add IndexedDB through its normal schema and transaction machinery. Decode the existing value representation once and queue writes without building a script string containing the full state. Preserve keys, indexes, auto-increment state and structured values. OPFS and other state types remain on the current path until their semantics are covered. Never transplant raw database files between live contexts.

Independent origin work can use bounded service concurrency, but the first version can remain sequential internally. Removing navigation, document creation and script compilation is the primary opportunity. Do not combine it with a speculative reset rewrite.

## Compatibility boundary

Initially support only initial restoration into a context with no live documents or workers. Live `setStorageState` calls can produce storage events, blocked database operations and concurrent writes; they need a separate design and retain the current path. Do not promise a new atomic snapshot guarantee where today's API has none.

Match origin normalization, storage partitioning, quota, serialization, database versions, error precedence and completion. Do not accidentally restore third-party partitioned storage into first-party buckets. Cancellation must either finish cleanup or discard the unpublished context; it cannot expose a partly restored context as ready. Select fallback before applying unsupported state.

Keep ordinary-browser support and a disable switch. New browser machinery belongs behind a negotiated command and small `Flashwright:` hooks. Retained [storage-ownership work](../workbench/native-storage-page-owner-001/plan.json) concerns Page/controller ownership, not a completed import service; it is not evidence of a speedup here.

## Payoff and first decision

The removable component is roughly one navigation and evaluation setup per origin, plus repeated source construction. Storage writes still cost time. Many-origin SSO setups and repeated large initial states have the strongest case; cookie-only state should keep its existing cheap path.

Later compare one/many origins, strict/recycled contexts and mixed storage types against the current fork. Check browser-visible restored data and failures, including duplicate keys, quota errors and cancellation. Include all import and disposal costs, CPU and memory.

Run storage-state/library coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report the whole `node bench/matrix.mjs` and scenario command from [bench/README](../bench/README.md), adding multi-origin cases and current-fork controls under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Build elsewhere and defer experiments while this machine is busy.
