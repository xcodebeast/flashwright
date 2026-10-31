# Keep optimized JavaScript running while collecting exact coverage

Scope: Chromium suites using `page.coverage.startJSCoverage()` on computation-heavy applications. Effort: monumental V8/compiler work. Priority: a high-ceiling research candidate within that scope.

**Assessed 2026-10-31:** rejected for now: V8 work (custom browsers are the last option), for coverage runs only.

Research, 2026-10-31, against `c4c3583b` and the live worktree. No engine build, profile or speed measurement.

## Where the work is

[`JSCoverage.start`](../packages/playwright-core/src/server/chromium/crCoverage.ts) enables precise coverage with both `callCount: true` and `detailed: true`. The checked-in [protocol definition](../packages/playwright-core/src/server/chromium/protocol.d.ts), under `Profiler.startPreciseCoverage`, explicitly says this prevents optimized code from running.

[V8's coverage explanation](https://v8.dev/blog/javascript-code-coverage) explains the underlying problem: optimized functions do not maintain the interpreter's invocation counters, and precise coverage must also preserve records that garbage collection could otherwise lose. Changing compilation thresholds cannot fix that accounting gap.

This is separate from [idea 42](42-test-aware-v8-compilation-policy.md), which schedules ordinary tiering. It also does not target Flashwright's Istanbul-based trace coverage: [`CoverageScript`](../packages/injected/src/coverageScript.ts) already sends counter deltas and sends maps once per document.

## Proposed change

Make precise coverage a supported compiler instrumentation mode. Allocate stable function/block counter slots and source-range metadata outside disposable feedback vectors. Teach baseline and optimizing tiers to update those slots while executing ordinary optimized application code.

Treat counter increments as required effects in compiler intermediate representation. Inlining must retain the original function's count; loop transformations, common-subexpression elimination and dead-code elimination must preserve the number and location of logically executed coverage points. A single increment at an optimized function's entry is insufficient for detailed block coverage.

Define a safepoint protocol for enabling, taking and stopping coverage. Enabling must replace or deoptimize uninstrumented active code before counted execution continues. Taking coverage copies and resets counters at the same logical boundary as the current API. Deoptimization and on-stack replacement must transfer accounting without counting an expression twice or losing it.

Keep source/range records alive for the session without retaining the full executable object graph. Release them according to reset-on-navigation and stop behavior. This may reduce retained memory, but only if the current engine's ownership constraints can be separated safely.

## Compatibility boundary

Keep exact counts and ranges, including zero-count regions, anonymous scripts, eval, exceptions, generators, async resumption and repeated take/reset cycles. Preserve the currently supported page/frame scope; do not silently broaden or narrow worker coverage. Never substitute sampling or binary hit coverage for requested counts.

Unsupported code paths must execute with ordinary precise coverage rather than report approximate results. Negotiate the browser capability before starting a session and retain the current engine path as a disable option. Maintain debugger and source-map behavior. Compiler changes need engine-level differential tests, not just a few passing browser assertions.

## Payoff and first decision

The ceiling is the execution penalty of losing optimized code, less counter and compilation overhead. It can dwarf protocol costs in an application doing repeated parsing, simulation or data processing. Short pages that never become hot may gain nothing or lose from added compilation.

First, on separate future capacity, establish whether precise coverage materially slows representative applications versus the same build without coverage. That comparison sizes the opportunity; it does not justify shipping coverage-free results. Then prototype one tier with exact counters and compare every reported range/count against today's precise mode.

Later run compiler/deoptimization coverage, Chromium JS coverage library tests, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report same-build precise-mode controls, coverage-heavy rows and the unchanged full [benchmark matrix](../bench/README.md), following the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No build or test work belongs on the currently busy machine.
