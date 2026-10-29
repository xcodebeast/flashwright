# Remove protection-only Chromium machinery in a dedicated browser build

**Scope:** an explicitly selected custom Chromium backend. **Effort:** monumental, spanning Chromium/V8 and platform maintenance. **Priority:** exploratory, and a last resort: the partial removals built so far measured no speedup.

Research proposal, updated 2026-10-29. **Status: partially implemented in private browser prototypes; incomplete and not shipped in current Flashwright.** Formerly `idea02.md`. This update inspects source and retained evidence only; no new builds or measurements.

## Evidence

The current [README](../README.md) explicitly says Flashwright uses Playwright's browser builds; the [browser manifest](../packages/playwright-core/browsers.json) selects Chrome for Testing/headless shell. [`Chromium._innerDefaultArgs`](../packages/playwright-core/src/server/chromium/chromium.ts) normally adds `--no-sandbox`. The recycling [launch switches](../packages/playwright-core/src/server/chromium/chromiumSwitches.ts) include a renderer-process limit. Neither runtime choice establishes removal of OS sandbox, site-isolation or V8 sandbox source machinery.

The retained [Idea 02 handoff](../workbench/idea02-current-handoff-001/report.txt) documents actual private Chromium 148/Linux builds with selected OS sandbox, site-policy/enforcement and V8 sandbox/check omissions. It explicitly marks all five original requirements short of complete acceptance. The [Linux build report](../workbench/idea02-linux-build-001/handoff-report.txt) records a linked source-removal stage, so describing this as an entirely unimplemented idea would be wrong.

The [combined-applications analysis](../workbench/idea02-combined-applications-002/analysis.json) records 480 passing test executions across 32 launches. On TodoMVC and SVGOMG, with one and four workers, the build with the removals ran within run-to-run noise of the normal build (about ±5%, faster in some runs and slower in others). Repeating those unchanged removals would add nothing. Those historical builds and narrow tests do not validate the current shipped browser or establish that completing the broader rewrite would help.

## Design

Retain the original three removal targets, with explicit dependency accounting:

1. **OS sandbox:** remove sandbox setup, policies, enforcement integrations and sandbox-only broker paths on supported platforms. Replace any shared resource/process services needed for ordinary browser operation. Existing selected Linux omissions are a starting point, not complete platform coverage.
2. **Site isolation:** remove physical isolation policy, enforcement and isolation-only process/IPC machinery. Refactor shared code to preserve navigation, frame/proxy lifetime, opener relationships, unload acknowledgements and message ordering. Document remaining process boundaries. Removal does not require single-process execution; APIs returning false are not proof that underlying machinery has disappeared.
3. **V8 sandbox:** remove sandbox-specific memory cages, indirection, checks and supporting code; adapt representations and allocation paths while retaining JIT, garbage collection and unrelated memory mechanisms. The [remaining-requirements review](../workbench/idea02-v8-remainder-review-001/remaining-requirements.json) distinguishes selected omissions from ordinary pointer-compression, GC, wrapper and Wasm consumers that must remain. Do not delete tables or allocators merely because their names mention sandboxing.

Implement separately selectable build stages with linked source/build manifests. Recover existing patches before rewriting them. For further work, identify materially different remaining runtime costs; do not repeat failed unchanged cuts or count an unused source-file deletion as a demonstrated runtime win. Keep browser integration in new files/patches with small marked hooks in upstream files.

## Compatibility and payoff

Preserve CORS, CSP, same-origin rules, TLS validation, permissions, application scheduling, trusted input and test/context storage isolation. The existing `webSecurity: false` option is not an implementation of this requirement. Preserve ordinary operand effects when removing checks and retain unrelated bounds, conversion and allocation behavior.

Removing protections changes the browser's security model even if selected web-visible behavior remains equivalent. Make this an explicitly identified custom build in configuration and reports, document the difference in README, and retain ordinary browser selection as the opt-out. Reject unsupported builds/platforms; never silently substitute a stock browser with disabling flags when the custom build was requested.

The intended payoff is less initialization, enforcement and isolation-only coordination work, potentially with fewer allocations/process resources. Current default launch flags already remove some runtime activity, limiting incremental gains. Shared frame/process and memory machinery remains functionally necessary; deleting it without replacements would be a regression, not an optimization. No broad speedup is established.

## Later decision test

First produce a precise remaining-dependency map for a selected new cut and verify its source/link closure. Compare identical-source builds with that stage on/off, keeping compiler settings and workload policy fixed. Match native/browser tests to the exact artifact; historical passes cannot transfer to a changed build.

Later run representation/JIT/GC/Wasm, cross-origin/frame/navigation, trusted-input, lifecycle and storage tests, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and the full `node bench/matrix.mjs`, including current-fork/ordinary-browser and stage-by-stage comparisons under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Build on separate capacity and defer all execution while this machine is busy.
