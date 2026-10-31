# Start browser utility worlds with the framework already initialized

Scope: many short documents, iframe-heavy pages and frequent fresh renderers. Effort: very large, requiring a matching Chromium build. Compatibility: no intended application behavior change.

**Assessed 2026-10-31:** deferred: needs a matching Chromium build. Measured: creating the injected script costs about 2.7 ms per document, about 2.2 ms of it sending and compiling its 179 KB source.

Research, 2026-10-31, against `1f613889` and the live worktree. No browser builds or timing probes.

## Evidence and distinction

[`FrameExecutionContext.injectedScript`](../packages/playwright-core/src/server/dom.ts) evaluates the injected bundle and constructs an `InjectedScript` for each execution context. [`ExecutionContext.utilityScript`](../packages/playwright-core/src/server/javascript.ts) separately creates its utility object. The fork already keeps source stable for browser compilation reuse, overlaps these operations and starts injection during navigation. Those savings are already present.

The [`InjectedScript` constructor](../packages/injected/src/injectedScript.ts) still creates selector engines, maps, sets, helpers and document-specific state. Cached bytecode does not eliminate module evaluation or object initialization. Chromium already has a [Blink context snapshot generator](https://raw.githubusercontent.com/chromium/chromium/main/tools/v8_context_snapshot/v8_context_snapshot_generator.cc), and V8 distinguishes [context snapshots from code caches](https://github.com/v8/v8/blob/main/docs/snapshot/architecture.md). These are integration primitives, not a supported Playwright snapshot API.

[Idea 09](09-preinitialized-node-runtime.md) snapshots Node framework startup. This snapshots the browser's automation realm. [Idea 28](28-declarative-browser-initialization.md) batches configuration before targets resume; it does not eliminate repeated JavaScript initialization within those targets.

## Design

Split the injected runtime into a snapshot-safe foundation and a per-document attachment phase. Prepare framework functions, selector definitions and immutable tables when building the browser. Give each automation utility world a fresh context restored from that foundation.

At attachment, bind the current Window, Document, captured builtins, options and frame identity. Allocate fresh mutable evaluator caches, handle registries, listeners and action state. Load user selector engines normally after restoration. Nothing supplied by a test belongs in the build-time image.

Expose a private versioned operation that creates the automation world and returns its runtime handle. Keep the current source-evaluation path for unsupported browsers, bundle mismatches, main-world execution and environments without a separate utility world. Start with utility-world helpers only; broadening the snapshot is a separate decision.

## Functional boundary

Do not serialize DOM wrappers, pending promises, timers, frame handles or references to a template global. Reconstruct every realm-sensitive value against the destination context. Module-level mutable caches must be private, even if their initial contents match.

Preserve protections against patched application builtins, clock emulation, custom engines, error formatting and recorder integration. Snapshot identity includes Chromium/V8 build, architecture, runtime bundle and relevant build flags. A mismatch must fall back before executing any action. Tests must not gain access to a shared mutable framework prototype through the new path.

## Payoff and later decision

The target is repeated initialization and injection traffic across documents, not browser process launch or application compilation. The ceiling is the remaining cost after today's stable-source cache and eager injection. A tiny single-page suite may see little change; thousands of short-lived frames could amplify it.

Later compare source evaluation with snapshot restoration across empty, small and many-frame documents. Count attach work, image size and total memory; a large image loaded into every renderer can lose. Follow the [whole-matrix procedure](01-browser-native-actions.md#payoff-and-decision-test), with current-fork controls, `tests/page` on `chromium-page`, selector/clock/frame tests and runner coverage against pristine upstream. Reconcile the cited Chromium main sources with the packaged revision before implementation.
