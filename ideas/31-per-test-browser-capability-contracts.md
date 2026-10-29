# Omit browser work through explicit per-test capability contracts

**Scope:** suites that can declare a restricted browser environment. **Effort:** very large, including browser enforcement. **Priority:** exploratory; target demonstrated subsystem costs before extending the prototype.

Research proposal, updated 2026-10-29. **Status: partially prototyped privately; not fully implemented or integrated into current Flashwright.** Formerly `idea01.md`. This update inspects source and retained evidence only; no new experiments or speed claims.

## Evidence

The current [`TestTypeImpl`](../packages/playwright/src/common/testType.ts) and [public test types](../packages/playwright/types/test.d.ts) do not expose `test.defineFeatures`. Existing [`test.use` options](../packages/playwright/src/index.ts), including `blockResources`, `instantAnimations` and upstream JavaScript/service-worker controls, do not provide a general enforced capability contract or specialized backend.

Substantial private work exists. The [contract prototype decision](../workbench/capability-contract-004/decision.json) records frozen declarations, painting/capture restrictions and targeted correctness checks, while leaving broader enforcement incomplete. Later evidence covers [DOM storage exclusion](../workbench/capability-dom-storage-006/export-summary.json), selected [IndexedDB discovery](../workbench/capability-indexeddb-discovery-012/decision.json) and [exclusion](../workbench/capability-indexeddb-exclusion-013/decision.json). A [network-boundary experiment](../workbench/capability-network-boundary-014/plan.json) targets service-worker initialization; it explicitly does not implement arbitrary network subsets. These are distinct partial implementations, not the whole proposal.

The later [backend timing decision](../workbench/capability-backend-timing-023/postrun-decision.json) records no configuration meeting its declared 20% elapsed-time reduction gate for painting/capture exclusion. It retains ordinary defaults and rejects repeating that unchanged screen. This does not disprove every capability specialization or establish a current-product speedup.

## Design

Allow declarations during test collection, before fixture/browser/context allocation. An illustrative API remains:

```ts
test.defineFeatures({
  navigation: true,
  javascript: true,
  eventListeners: true,
  layout: true,
  painting: false,
  screenshots: false,
  storage: ['localStorage'],
  network: ['document', 'fetch'],
});
```

Names and granularity are provisional; this is not a supported API. The declaration covers application code, dependencies, frames, workers and test operations. In the opt-in strict contract mode, omitted capabilities are excluded. Resolve documented dependency closure, reject unknown entries and explicit conflicts, and reject unsupported exclusions before allocation. Freeze the resolved contract for each attempt, including retries; separate incompatible process/context profiles and never recycle state across incompatible contracts.

A specialized backend omits eligible subsystem initialization, allocations and work. Detect excluded dependencies before their effects and report a typed failure containing the capability, operation and available source location. Native violations need a channel that application try/catch cannot hide from the runner. Never fabricate success or silently broaden the contract.

Discovery runs the full backend and suggests declarations from observed use. Extend existing discovery experiments rather than assuming this starts from zero; observed coverage cannot certify unexecuted paths. Enforcement remains active on every restricted run.

## Compatibility and payoff

Keep layout, painting and capture separate. Preserve actionability, trusted input, hit testing, event order and scheduling. The existing painting experiment needed a combined-text fallback to preserve input metadata: removing drawing indiscriminately is already known to be unsafe. Preserve feature availability/probing where supported and account for implicit browser use; reject exclusions that cannot meet this boundary.

Default execution remains unrestricted. Document supported restrictions and their opt-out in README before release, and report restricted runs as validation of the declared environment, not unrestricted browser compatibility. This differs from [declarative initialization](28-declarative-browser-initialization.md), which retains all capabilities.

Potential savings depend on how much omitted work lies on the suite's critical path. Lower raster activity or fewer allocations alone does not prove faster tests. Recover applicable prototype code and identify a materially useful missing capability before undertaking another browser build.

## Later decision test

For each supported exclusion, test explicit and implicit use, caught violations, feature probes, frames/workers, retries and incompatible reuse. Compare permitted observations with the full backend under the same artifact policy. Unsupported declarations must fail before their effects.

When the machine is available, run `tests/page` on `chromium-page`, relevant library coverage and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report restricted-mode results separately alongside `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and the full `node bench/matrix.mjs`, including current-fork and same-build unrestricted baselines. Follow the [shared evaluation rules](01-browser-native-actions.md#payoff-and-decision-test); no builds or benchmarks are required for this documentation update.
