# Make JavaScript compilation decisions fit short test lifetimes

**Scope:** JavaScript-heavy applications repeatedly opened for short tests. **Effort:** very large, requiring pinned V8/Chromium integration. **Priority:** exploratory; useful only if ordinary engine policies leave material work on the critical path.

**Assessed 2026-10-31:** deferred: V8 flag experiments (`--no-maglev`, `--no-opt`, `--max-lazy`) measured 0 to -10% earlier.

Research proposal, 2026-10-31. No engine flags changed, profiles collected or builds run. This changes when application code is compiled and optimized. [Automation-trained browser builds](18-automation-trained-browser-build.md) optimize Chromium's native binary; [portable bytecode](19-portable-application-bytecode-cache.md) reuses compilation artifacts. Neither is a test-lifetime policy for JIT decisions.

## Evidence

Flashwright's [fresh-page lifecycle](../packages/playwright-core/src/server/browserContext.ts) can make an application's useful execution much shorter than an interactive browsing session. Warm renderers already preserve useful compilation state, so a blanket claim that every test starts with a cold engine would be false.

[V8's Maglev explanation](https://v8.dev/blog/maglev) describes the tradeoff between compile cost and faster execution. The upstream [`TieringManager`](https://chromium.googlesource.com/v8/v8/+/main/src/execution/tiering-manager.cc) already uses invocation budgets and cached early/delayed tiering decisions. [Explicit compile hints](https://v8.dev/blog/explicit-compile-hints) also support eager compilation choices. The proposal must improve on the pinned browser's existing heuristics, not merely enable tiering, caching or hints that already exist.

## Proposed change

Add an optional automation compilation policy informed by prior executions of the same application version and by current test boundaries. Store only bounded scheduling statistics keyed by exact script content, function position and engine/configuration identity: first-use phase, call frequency, compile cost and whether optimized code was subsequently used.

Use those statistics as hints in three separate decisions. Prepare known startup functions during existing background compilation opportunities. Advance cheap baseline or mid-tier compilation for functions likely to repay it within the test. Delay expensive top-tier jobs whose results consistently arrive after their document has closed. Unknown code keeps ordinary V8 decisions.

Keep type feedback, object shapes, closures and speculative assumptions private to the current execution. A prior function's popularity is not proof that this run has the same types. All guards, deoptimization and language checks remain. Stop or deprioritize obsolete compile work only when no surviving document or shared function needs it; a page closing does not make its entire isolate disposable.

Deliver hints through a native side table after source verification. Do not rewrite scripts to insert magic comments: that can change source text, integrity checks and debugging. Expose the test boundary through a narrow versioned interface, leaving unsupported browsers on their normal policy.

## Compatibility

Preserve application execution, exceptions, async ordering, coverage, debugger behavior and fresh context state. Do not execute functions speculatively to train them. Missing, stale or misleading history must change only optimization choices, never test selection or results.

Compilation scheduling changes timing and resource use; offer a disable switch and document exposed differences in README. Coverage/debug modes can initially use normal decisions. Keep browser revision, graphics settings and security behavior identical to the control build. Do not use compiler fuzzing/stress flags as production performance settings.

## Payoff and later decision

Earlier cheap compilation can shorten repeated startup and handlers; avoiding useless optimization can save CPU and code memory. Either can also lose: eager work may contend with rendering, and delayed optimization may hurt a long test or a later warm-page load. The target is net compile-plus-execution cost across the complete suite, not fewer compile events.

First attribute ordinary tiering on held-out short and long applications. Then change one decision at a time against the same engine with its normal cached heuristics. Include no history, stale history, strict/recycled contexts and one/four workers. Keep preparation and any continued background compilation inside resource accounting.

Later build on separate capacity; run engine language/JIT/deoptimization coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report current-fork/same-build policy controls beside `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and the whole `node bench/matrix.mjs`, including held-out CPU-heavy apps under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Reject gains that depend on a perfectly trained published benchmark.
