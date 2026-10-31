# Release temporary browser handles as an operation-owned group

Scope: operations that create many temporary DOM/JavaScript handles, large handle collections and cross-world evaluations. Effort: large. Potential: reduce protocol commands and make temporary browser roots easier to reclaim completely.

**Assessed 2026-10-31:** deferred: releases are sent without waiting; a TodoMVC test sends about 7.

Research proposal, 2026-10-31. No implementation or measurements.

## Evidence and distinct opportunity

[`JSHandle.dispose`](../packages/playwright-core/src/server/javascript.ts) marks a handle disposed and starts an asynchronous release. Chromium's [`releaseHandle`](../packages/playwright-core/src/server/chromium/crExecutionContext.ts) sends one `Runtime.releaseObject` per object through [`releaseObject`](../packages/playwright-core/src/server/chromium/crProtocolHelper.ts). Bulk disposal therefore creates many command/callback records even when releases are issued concurrently.

[`FrameSelectors.queryAll`](../packages/playwright-core/src/server/frameSelectors.ts) creates an array handle, gets its properties, adopts elements into another world and disposes the source handles. `evaluateExpression` also disposes temporary adopted arguments individually. The browser already has object-group fields and `Runtime.releaseObjectGroup` in the [local protocol schema](../packages/playwright-core/src/server/chromium/protocol.d.ts), but this delegate does not assign groups.

[Idea 74](74-bulk-element-handle-adoption.md) batches creation/adoption commands. This proposal changes the ownership and reclamation of temporary inspector roots. It can remove release commands even if adoption remains unchanged. [Idea 48](48-test-lifetime-heap-regions.md) changes the garbage collector; this uses inspector facilities without changing GC.

## Proposed change

Give selected internal operations an explicit remote-handle scope per session/execution context. Every temporary result created for that scope receives a unique object-group name. When the operation has finished all browser work that uses those objects, release the group once and mark its local wrappers disposed.

Start with bulk query source handles whose adopted results have separate destination ownership. Keep caller-owned handles, the utility script and injected script outside temporary groups. Grouping must follow allocation ownership, not merely the currently active async call: concurrent operations can borrow the same handle.

Thread the scope through internal evaluation and adoption delegates. Audit object-group inheritance for `Runtime.callFunctionOn`, property enumeration and `DOM.resolveNode`. Never let a result accidentally inherit the long-lived utility script's group. Where inheritance cannot express safe ownership, retain individual releases or use a narrowly scoped browser extension.

Escaping results need promotion to independent ownership before group release, with no change to JavaScript object identity. Promotion can require another command; restrict the fast path to cases where savings exceed that cost. Small operations can retain today's behavior. Add command-count accounting only in a later prototype.

## Compatibility boundary

Public handles remain usable until explicitly disposed or their context disappears. Releasing an internal group must not invalidate a public alias, pending evaluation, console-history argument or another operation's temporary reference. Reusing a group name after navigation is unsafe; include session and document identity.

Cancellation releases only after in-flight browser work has stopped using the group. Context destruction is a terminal cleanup case, not an error to replay against a replacement context. Do not defer roots until test end to manufacture fewer commands. Keep disposal timing at the existing operation boundary and retain per-object cleanup for unsupported paths.

## Payoff and later decision

The target is replacing `N` release messages with one for an operation owning `N` disposable roots. Releases already overlap, so `N` saved messages does not mean `N` saved round trips. The likely gains are protocol CPU, allocation and shorter cleanup backlogs, strongest with large collections.

Later test thousands of elements, mixed borrowed/escaping handles, concurrent operations, cancellation and navigation races. Count retained browser roots after completion, not just command traffic. Run evaluation/handle/frame library coverage, `tests/page` on `chromium-page` and runner regressions against pristine upstream. Apply the [full comparison procedure](01-browser-native-actions.md#payoff-and-decision-test), counting promotion, release and final cleanup. Do not test on the occupied machine.
