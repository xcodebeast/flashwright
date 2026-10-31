# Adopt a collection of element handles with one browser command

Scope: `page.$$`, `locator.elementHandles()` and other operations returning many DOM handles. Effort: very large for a browser extension. Potential: eliminate thousands of protocol commands from one collection operation.

**Assessed 2026-10-31:** deferred: only `$$`/`elementHandles()` over many elements, and it needs a browser extension.

Research, 2026-10-31. Local source and protocol documentation only; no handle collections or benchmarks executed.

## Evidence and difference from existing ideas

[`FrameSelectors.queryAll`](../packages/playwright-core/src/server/frameSelectors.ts) queries in the selector's world, obtains array properties, then adopts every element into the main world. It already uses `Promise.all` for adoption. The missing optimization is fewer commands, not adding concurrency.

In Chromium, [`FrameSession._adoptElementHandle`](../packages/playwright-core/src/server/chromium/crPage.ts) sends `DOM.describeNode`, then `DOM.resolveNode` in the destination execution context. When N handles need adoption, this adds 2N commands, their replies and intermediate objects. Those are not 2N sequential round trips. The [CDP DOM interface](https://chromedevtools.github.io/devtools-protocol/tot/DOM/) exposes these single-node operations.

[Idea 65](65-cardinality-aware-selector-execution.md) stops queries that need fewer results. Here the caller explicitly needs every handle. [Idea 24](24-packed-evaluation-values.md) optimizes value graphs, not live DOM references.

## Proposed change

Add an internal `adoptElementHandles` delegate operation. For a compatible Chromium extension, send the ordered source object IDs and destination execution-context identity together. Resolve and wrap the nodes through the browser's existing DOM/V8 machinery, returning ordered descriptors in one response.

The browser still performs O(N) node work. It avoids O(N) protocol envelopes, callback records and repeated command dispatch. Use bounded batches for extreme collections so one command does not monopolize the renderer or build an unbounded response.

Keep querying in its original world. Moving the query to the page's main world can expose patched application APIs or change custom selector behavior. Likewise, do not smuggle nodes through DOM properties or page-visible registries to cross worlds.

Treat temporary handles as one owned operation. Where safe, use an object group for intermediates and release it on success or cancellation. Returned public handles need independent lifetimes and must survive that release. Chromium already supports [remote object groups](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/js_protocol.pdl); group cleanup alone does not provide bulk adoption.

## Compatibility boundary

Preserve result order, node identity, duplicates, detached-node behavior and each handle's destination world. Handle navigation, destroyed execution contexts and partial adoption failures without leaking the successfully created prefix. A failed batch must not silently rerun a custom selector.

Partition batches by source session and destination context. Out-of-process frames cannot share an unqualified object-ID namespace. Keep individual `dispose()` behavior, trace attribution and public errors unchanged. Unsupported browsers, external CDP connections and incompatible revisions use the existing delegate.

One browser task may expose a different race boundary from many commands. Retain necessary task checkpoints, and compare navigation/detachment races explicitly. The command must not become permission to change the public handle contract.

## Payoff and later decision

The strongest target is hundreds or thousands of requested handles, especially over a remote browser connection. Ordinary locator clicks request one element and should not be credited with this benefit. Final public handle objects still consume O(N) memory; savings are intermediate metadata and transport work.

Later measure complete collection, use and disposal with increasing result sizes, including main-world queries that already avoid adoption. Compare command counts, wall time, CPU and browser/Node memory. Validate returned handles through evaluation, detachment, navigation and individual disposal.

Run handle, selector and frame coverage plus the [full matrix and upstream regression procedure](01-browser-native-actions.md#payoff-and-decision-test). Include current-fork and same-browser controls. Browser development and builds belong on separate capacity, not this busy machine.
