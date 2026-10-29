# Make tracing proportional to what changed

**Priority:** high when traces are enabled · **Scope:** CI diagnostics, large DOMs and action-dense traces · **Effort:** large.

**Status:** partly implemented, differently. On ordinary pages the largest trace cost was not snapshot traversal: traces fetched every script body from the browser and then threw it away, which held up each page load. `d1ef099a` stopped that, making traced runs 1.43× faster on TodoMVC with one worker. Not done: dirty-subtree capture. On small pages most of what remains is the round trip of each snapshot, about 0.3 ms, not the size of the DOM.

Research proposal, 2026-10-29. No new performance measurements. Trace-off runs should incur no new observer or processing work.

## Remaining cost

[`Streamer.captureSnapshot`](../packages/playwright-core/src/server/trace/recorder/snapshotterInjected.ts) already reuses node references and cached attributes/styles. It nevertheless visits the tree to establish whether nodes and descendants are unchanged. Its MutationObserver and CSSOM interception are existing optimizations, not missing features.

[`Snapshotter.captureSnapshot`](../packages/playwright-core/src/server/trace/recorder/snapshotter.ts) collects frame snapshots and resources. [`Tracing.onBeforeCall`, `onBeforeInputAction` and `onAfterCall`](../packages/playwright-core/src/server/trace/recorder/tracing.ts) await configured snapshot capture at logical action phases. Trace events/resources also need serialization, hashing, file writes and eventual archive work. Merely making ZIP creation asynchronous would not remove page-side traversal or synchronous phase capture.

A retained private [mutation-version prototype](../workbench/snapshot-dirty-prototype-001/analysis.json) recorded selected content-control successes, while explicitly leaving product lifecycle/memory and integrated viewer/driver validation open. It is preliminary evidence for a mechanism, not a current-suite speed claim. Recover and review that prototype before writing another one; the remaining opportunity is compatible integration into this implementation.

Its two-pair diagnostic screen recorded candidate/resident browser-flow time ratios of 0.707–0.752 for large ASCII/Unicode cases, but 0.974–1.013 for the small case. Those synthetic flows exclude independent output decoding/writes; they show both a promising large-DOM signal and no dependable small-page benefit. They do not establish a Flashwright suite speedup.

## Proposed mechanism

Maintain a persistent snapshot tree with dirty subtrees. Each node stores its last immutable snapshot representation; a change dirties the node and necessary ancestors. At a capture boundary, drain mutation records, sample known volatile state, and rebuild only dirty paths. Reuse clean subtrees directly without walking every descendant.

Start with a conservative inventory of volatile nodes: form values/selection, scroll positions, iframe state, style-sheet references and action targets. Preserve the current CSSOM invalidation. If a native browser generation API is eventually added for [locator indexes](05-incremental-locator-indexes.md), reuse its change notifications, but tracing must remain independently correct without that proposal.

Keep phase capture on the page's critical path only long enough to freeze an immutable logical snapshot. Transfer ownership of captured payloads to a bounded artifact worker for hashing, serialization, compression and writes. Assign sequence numbers before offloading so event order does not depend on completion order. Batch small writes; use binary staging internally if it lowers copying, while exporting the existing trace JSON/resources/ZIP format.

Do not delay actual screenshot/DOM capture until after the action: that would record the wrong page state. Screenshot encoding/comparison work can share infrastructure with [idea 04](04-raw-screenshot-comparison.md), but requested image capture boundaries remain unchanged.

## Functional contract

Dirty tracking must cover text, child lists, shadow/slot changes, live DOM properties, adopted/CSSOM stylesheets and navigation. A node removed and reinserted cannot inherit a stale reference. Drain pending records before capture; use a full traversal whenever validity is uncertain. Preserve iframe references, target markers, redaction rules, resource bodies and viewer reconstruction. Disconnect observers and release retained trees when tracing stops or their original execution context is destroyed; canceled installation and navigation races must not leave observers running in the application.

Retain existing trace modes and their diagnostic coverage, including successful-attempt data when a mode promises it. No silent event dropping under load. Apply backpressure when the queue reaches its byte limit, and flush required artifacts before the result promises them. Worker failures must produce a reported trace error or a correct synchronous fallback.

## Payoff and decision test

**First experiment:** integrate dirty-subtree capture into the real snapshot lifecycle behind a switch, retaining full traversal as the reference. Reconstruct both traces in the viewer and compare every phase, including navigation and trace restart. Measure observer overhead during actions, not just capture duration.

The target is changing repeated traversal from roughly `actions × DOM size` to initial capture plus changed paths and volatile-state checks. A highly dynamic page may still need a full walk. Offloading helps wall time only with spare CPU; bound worker concurrency so four browsers do not lose CPU to four compression workers.

When the machine is free, add trace-on versions of TodoMVC/shop and large mostly static/churning DOM suites; the current published trace-off matrix cannot establish this benefit. Compare trace size, reconstruction, CPU and end-to-end flush time using the [full evaluation rule](01-browser-native-actions.md#payoff-and-decision-test). Run `tests/page` on `chromium-page`, [`tracing.spec.ts`](../tests/library/tracing.spec.ts), trace-viewer coverage and `tests/playwright-test` against pristine upstream. Reject any speedup obtained by losing a recorded state or exporting artifacts after they are expected to exist.
