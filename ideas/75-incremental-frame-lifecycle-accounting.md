# Update frame lifecycle state only along changed branches

Scope: applications with large iframe trees, embedded dashboards and frequent frame navigation. Effort: medium to large. Potential: remove quadratic bookkeeping during frame-heavy loads.

**Assessed 2026-10-31:** deferred: only pages with large iframe trees.

Research, 2026-10-31. Source inspection only; no pages loaded or timings collected.

## Evidence and difference from existing ideas

[`Frame._recalculateNetworkIdle`](../packages/playwright-core/src/server/frames.ts) recursively visits every descendant before deciding whether a frame's subtree has reached network idle. Calls begin at the main frame after lifecycle events, lifecycle clearing, frame detachment and individual idle-timer completion.

For F frames, one call visits O(F) frames. A load with O(F) such triggers can perform O(F²) visits even in a shallow tree. This bookkeeping exists independently of whether user code explicitly awaits `networkidle`.

[Idea 60](60-native-browser-idle-tracking.md) concerns Flashwright's early assertion failure detector. This proposal preserves Playwright's separate network-idle lifecycle algorithm and its existing 500 ms timers.

## Proposed change

Maintain each frame's own idle state and a count of immediate children whose published lifecycle state is not idle. A child transition updates its parent's count. Recompute affected ancestors until their published state stops changing, rather than traversing unrelated siblings.

Use dirty-branch tracking at the existing recomputation boundaries. This matters because `_stopNetworkIdleTimer` changes internal state without immediately invoking the full traversal. Eagerly publishing a new state on every request would change current behavior. Record the change, then process it when today's code would recompute.

Attach and detach update parent counters explicitly. Navigation gets a new document generation and resets only the relevant state. Preserve the special handling of the frame passed to `_recalculateNetworkIdle`; do not replace its actual add/remove rules with a cleaner but different interpretation of the comments.

Start with subtree summaries and dirty paths while keeping a reference implementation available. A debug-only differential mode can compare resulting state and emitted events when experiments are later authorized. Do not leave a second full traversal enabled in production.

## Compatibility boundary

Match the existing sequence of `AddLifecycle` and `RemoveLifecycle` notifications, including child-before-parent ordering. If several branches became dirty, process them in the same frame-tree order as the original traversal. Synchronous listeners and reentrancy require care: update counters and state at equivalent points.

Keep request accounting, favicon exclusions, timer start/stop rules, navigation responses, timeout behavior and detached-frame handling unchanged. Out-of-process frame swaps must not double-count a child. A stale timer from an earlier document cannot update a replacement document.

Do not remove the 500 ms quiet period or gate bookkeeping solely on current listeners. A later wait must observe the same lifecycle state as before.

## Payoff and later decision

For a shallow tree, the target is work proportional to changed frames and their ancestor paths, rather than every frame on every trigger. A deep chain can still require O(F) propagation when every ancestor changes. A normal one-frame app has little opportunity here.

Later compare event histories against the current implementation for wide/deep trees, frames that continually load resources, detach during navigation and same-process/out-of-process swaps. Measure total navigation time and Node CPU, not merely the helper's runtime. Retained accounting should cost O(F), without a history that grows across navigations.

Run [`page-network-idle.spec.ts`](../tests/page/page-network-idle.spec.ts), frame/navigation tests and the [full matrix and pristine-upstream comparison](01-browser-native-actions.md#payoff-and-decision-test), with large-frame additions and current-fork controls. No experiments now.
