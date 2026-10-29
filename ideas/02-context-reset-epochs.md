# Reset contexts by switching storage generations

**Priority:** high · **Scope:** suites with many isolated tests · **Effort:** very large for the full design.

Research proposal, 2026-10-29. Source-backed hypothesis; no new measurements. This extends the existing recycling path rather than proposing context reuse again.

## Remaining cost

[`BrowserContext._resetForRecycle`](../packages/playwright-core/src/server/browserContext.ts) already overlaps page shutdown, opening the next tab, permission/cookie clearing, storage cleanup and cache clearing. Nevertheless, each boundary still performs browser work. [`CRBrowserContext.doClearSiteData`](../packages/playwright-core/src/server/chromium/crBrowser.ts) sends `Storage.clearDataForOrigin` for each visited origin and separately stops surviving service workers. [`CRNetworkManager.clearCache`](../packages/playwright-core/src/server/chromium/crNetworkManager.ts) also toggles cache settings and clears the browser cache.

Parallelizing these calls further does not eliminate the work or the isolation barriers. The repeated clearing and restoration of unchanged `storageState` is another possible cost, especially for authenticated suites.

## Proposed mechanism

Give a recycled context a fresh internal **generation** at every test boundary. A generation owns cookies, origin storage, cache namespaces, service-worker registrations, permissions and network/auth state. The next generation starts from an immutable, validated `storageState` baseline and gets a fresh tab/global environment. Writes go to its private overlay; the baseline is never mutated.

At reset, first stop or fence every old producer. Then switch the context to a new generation and acknowledge completion once nothing old can affect it. Reclaim unreachable old data in bounded batches. This changes reset cost from deleting all previous data to installing a new namespace; total disposal still happens and must be counted.

This requires browser-owned identifiers on async storage/network operations. Prefixing localStorage keys in JavaScript is insufficient: it misses native cookie handling, workers, IndexedDB, caches and cross-frame activity.

Chromium's [StoragePartition interface](https://chromium.googlesource.com/chromium/src/+/main/content/public/browser/storage_partition.h) groups the persistent-state view exposed to child processes. A fresh partition is therefore not automatically a cheap generation switch. Establish whether generations can preserve the warm renderer and its compiled code; otherwise the reset savings may be lost to renderer initialization.

Start with a smaller milestone: browser-side dirty tracking and a single reset command. Record actual mutations and option changes, then omit only cleanup proven unnecessary. A visited origin is not evidence that every storage subsystem changed. Unknown or unsupported state forces the existing full reset. This milestone can expose the ceiling before building generation-aware storage.

## Functional contract

- Fence late responses, Set-Cookie processing, worker writes, BroadcastChannel/SharedWorker messages, downloads and delayed browser events. Stopping document JavaScript alone is insufficient.
- Preserve storage keys/partitioning, quota and permission behavior, HTTP cache semantics, routes, bindings, init scripts, clock cleanup and `storageState` restoration. Reusing a compiled script must never preserve application globals.
- Keep fresh tabs and dispose stale handles. Do not let old context events surface in the next test.
- Bound retired generations and pending deletion. If reclamation falls behind, drain or use ordinary context creation; do not hide a growing memory/disk bill after the timer stops.
- Retain `FLASHWRIGHT_ISOLATION=strict` as the genuinely fresh-context path. Unsupported engines, recording/debugging and uncertain reset coverage keep their current behavior.

## Payoff and decision test

**First experiment:** classify each existing reset operation as required or provably redundant in no-storage and repeated-authentication workloads. Include page creation, producer shutdown and `setStorageState` in the boundary timing. Prototype dirty tracking before changing storage ownership.

Potential savings scale with test boundaries, visited origins and repeated storage-state restoration, rather than action count. Dirty tracking could save deletion/restoration CPU; generation switching mainly moves reclamation away from the critical path and does not eliminate its CPU bill. Memory could improve by sharing an immutable baseline, but overlays and deferred reclamation could also increase it. Neither outcome is established.

When resources are available, measure the reset critical path separately from navigation, then evaluate total-suite wall time with the [full comparison procedure](01-browser-native-actions.md#payoff-and-decision-test). Include noop/setup, authenticated shop, multi-origin, storage-heavy and many-worker suites. Extend [`recycle-isolation.spec.ts`](../tests/page/recycle-isolation.spec.ts) with adversarial late writes, service workers, partitioned storage and quota churn; run upstream `tests/page` on `chromium-page`, storage/service-worker library tests and runner tests against pristine upstream. Abandon generation switching if complete isolation cannot be proved at the browser boundary, or if the deferred work removes the wall-time gain.
