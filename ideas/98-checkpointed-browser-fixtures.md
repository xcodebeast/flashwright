# Restore an initialized application page into a fresh test branch

Scope: suites that repeat expensive editor startup, hydration or client-side data preparation. Effort: monumental, including browser/runtime changes. Compatibility: an explicit new fixture contract, never a silent replacement for navigation.

**Assessed 2026-10-31:** deferred: monumental browser and runtime work behind a new fixture contract.

Research, 2026-10-31, against `1f613889` and the live worktree. No snapshots or experiments taken.

## Evidence and distinction

The [built-in page/context fixtures](../packages/playwright/src/index.ts) keep framework setup cheap but still give each attempt fresh application state. [`PagePreload`](../packages/playwright-core/src/server/pagePreload.ts) can overlap one future navigation with another test. It still initializes another page each time and discards unsuitable preloads.

[Idea 39](39-checkpointed-application-backends.md) checkpoints external backends and deliberately excludes the browser. [Idea 51](51-back-forward-cache-mode.md) restores one history entry within a page. This proposal creates independent test branches from the same initialized DOM and JavaScript state. It removes repeated application execution, beyond the compilation reuse of [idea 19](19-portable-application-bytecode-cache.md).

The [local CDP schema](../packages/playwright-core/src/server/chromium/protocol.d.ts) exposes page freezing and MHTML capture, neither of which clones a running application. [V8 heap/context snapshots](https://github.com/v8/v8/blob/main/docs/snapshot/architecture.md) also do not capture an entire Blink page, its browser services or its external effects. A new checkpoint boundary is required.

## Design

Introduce a fixture with distinct preparation and branch phases. The author prepares a page once, declares the point at which it is reusable, and supplies a restore hook for per-attempt identity. Tests receive a ready page from a private branch; they do not call `goto()` and receive invented navigation events.

At a browser safepoint, capture the joint V8/Blink object graph, DOM, event registrations and supported task state. Pair it with consistent context storage. Restore into fresh target/session identities with copy-on-write backing where possible. Keep mutable JavaScript objects, DOM nodes and storage private after the first write. Rebuild compositor resources if copying them is slower or unsafe.

Start with one document, completed requests, no workers, sockets, media, GPU resources or external handles, and no pending application tasks. Refuse a checkpoint that cannot prove this boundary. Broaden support only through explicit serialization/rebinding rules. This first subset already covers some expensive deterministic client initialization.

## Functional boundary

Preparation side effects happen once by contract. Ordinary `beforeEach`, navigation and arbitrary hooks must not be skipped automatically. Backend state must be independent per branch or restored through a compatible backend fixture; cloning the browser alone cannot undo a purchase or database write.

Define time and randomness explicitly. Never clone credentials, unique IDs or RNG streams under an assumption that they remain fresh. Restore hooks may regenerate per-attempt state, but cannot repair unknown application references. Reject unsupported cases before running a test, not after external side effects.

Restore trace/report ownership and browser handles for each attempt. Retries start from the same declared baseline, not a failed branch. Destroy branches fully, including after interruption. Document the setup-frequency difference and ordinary-fixture opt-out in README if implemented; strict isolation must not select this mode implicitly.

## Payoff and later decision

Compare `prepare + N × (restore + rebind + dispose)` with `N × ordinary initialization`. The ceiling includes actual application execution, so it can exceed driver optimizations. Copy-on-write faults, baseline memory and restore hooks may erase it.

Later start with one deterministic editor and compare branch independence, event behavior and pixels before timing. Include full preparation/teardown in the [matrix and current-fork comparison](01-browser-native-actions.md#payoff-and-decision-test), plus checkpoint-specific engine tests, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream. Compare with existing `preloadPages`; overlap alone may be cheaper than checkpoint machinery.
