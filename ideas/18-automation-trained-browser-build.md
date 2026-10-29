# Train the browser build for automation workloads

**Scope:** CPU spent inside Chromium across navigation, DOM work, layout and protocol handling. **Effort:** very large operationally. **Priority:** exploratory broad-impact opportunity.

Research proposal, 2026-10-29. No browser build, profile collection or performance claim. This retains browser subsystems and behavior; it is distinct from the existing capability-contract and protection-removal proposals.

## Evidence and opportunity

The [README](../README.md) says Flashwright uses Playwright's browser builds. Local optimizations change action/wait orchestration, but CPU-heavy work still runs inside that binary. Existing notes identify browser-side selector/action and screenshot paths; they do not establish how well the browser machine code is optimized for repeated short automation sessions.

[Chromium's PGO documentation](https://chromium.googlesource.com/chromium/src/+/main/docs/pgo.md) describes both default profiles for official builds and generating a custom profile. Therefore the proposal is **not** merely to enable profile-guided optimization. First inspect the exact distributed build configuration; the opportunity is a representative automation-trained profile versus its actual existing profile, with otherwise identical source and toolchain.

## Design

Build an instrumented version of the pinned Playwright-compatible Chromium revision on a separate build machine. Train it on a diverse automation corpus: short and long navigations, recycled and strict contexts, DOM/role queries, input, frames, workers, routing, canvas, screenshots and recording. Include normal browser JavaScript execution, not only DevTools no-ops.

Use the resulting profile to guide native compiler inlining, branch layout and hot/cold code placement. Keep platform/architecture-specific profiles and all ordinary browser semantics. Evaluate link-time optimization or post-link layout only as separate changes against the existing build settings; do not credit optimizations already enabled upstream.

Hold out applications and workloads from training. A profile trained only on TodoMVC could overfit the published matrix and hurt real suites. Include failure and teardown paths so optimizing happy paths does not make rare failures catastrophically slow.

Package a revision-pinned optional browser build with manifest, profile provenance and a stock-browser fallback. Use automated build configuration/scripts instead of invasive browser-source edits wherever possible. Profile collection is release engineering, never something an ordinary user's test run should trigger.

## Compatibility boundary

Keep the same browser revision, patches, Web APIs, process model, graphics backend and security behavior. This is a native machine-code optimization, not disabling checks or changing V8 language semantics. Avoid fast-math or other switches that can change observable results. CPU instruction requirements must match supported machines or select compatible artifacts explicitly.

Compiler/profile changes can expose bugs, change timing-sensitive behavior or worsen instruction-cache pressure. Full behavioral regression coverage remains necessary. Profiles must come from controlled fixtures without private user payloads. Build and distribution maintenance are ongoing costs, even if the patch footprint is small.

## Payoff and later validation

The upside applies repeatedly to browser CPU, potentially complementing Node-side optimizations. It cannot remove backend latency or waits, and no large gain is established. If fraction `f` of critical-path time is affected and that part speeds up by `s`, the serial model is `1 / ((1 - f) + f / s)`; do not substitute total multicore CPU share for `f`.

First compare identical-source builds using the existing versus automation profile. Measure whole-run wall time, CPU, memory, binary size and cold startup on held-out workloads. Reject profiles that improve only training examples or regress important workloads.

Once separate build capacity and benchmark time are available, run `tests/page` on `chromium-page`, broad browser library tests and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report `node bench/run.mjs todomvc 1 15 stock,fork` and the entire `node bench/matrix.mjs 15`, plus a current-fork/stock-browser comparison, cold/warm runs and held-out CPU-heavy apps. Follow the [shared rules](01-browser-native-actions.md#payoff-and-decision-test); do none of this build work on the currently busy machine.
