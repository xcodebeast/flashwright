# Run supported test control flow inside the browser

**Scope:** browser-only, command-dense tests, especially when the current driver is remote. **Effort:** monumental, including a browser runtime and automation bridge. **Priority:** moonshot; simpler driver colocation must be the comparison.

Research proposal, 2026-10-31. No implementation or measurements. [Browser-native actions](01-browser-native-actions.md) move one action at a time. This moves the test's loops, branches and awaits, while preserving each public operation boundary.

## Evidence

[`WorkerMain`](../packages/playwright/src/worker/workerMain.ts) invokes test functions in Node. Their library calls cross [local dispatch](../packages/playwright-core/src/inprocess.ts) and then browser transport; [`CRExecutionContext`](../packages/playwright-core/src/server/chromium/crExecutionContext.ts) sends evaluations through `Runtime.callFunctionOn`. Many tiny operations repeatedly leave and reenter the browser even when the test uses no filesystem or other Node service.

Browser execution of test modules is established practice: [Web Test Runner loads tests as browser ES modules](https://modern-web.dev/docs/test-runner/writing-tests/js-tests/). That does not supply Playwright semantics, trusted input or navigation-surviving control flow. Those are the substantial missing pieces here.

## Proposed change

Add an explicitly selected browser-test execution target for a declared API subset. Package the test, compatible fixtures and assertion code as modules for a browser-managed automation runtime. Keep the runner responsible for collection, scheduling, real watchdogs, reporting and Node-only setup.

The automation runtime must outlive document navigation and remain separate from application globals. A document-injected script that disappears on `goto()` is insufficient. Give it stable page/frame identities and a native asynchronous bridge to the browser's automation services. Cross-renderer navigation rebinds targets without serializing and restoring an arbitrary JavaScript continuation.

Run ordinary JavaScript control flow there: each await still completes only when its operation completes. DOM queries can use existing injected semantics; input still goes through trusted browser input dispatch. Never replace a click with DOM `.click()` or collect several operations into an atomic block. Browser IPC, rendering checkpoints and route/dialog coordination remain necessary.

Start with reads and assertions in one page, followed by navigations and trusted actions. Deliver ordered step events and failures back to the normal reporter interface. An explicitly awaited host-call bridge can support a narrow set of Node services later; frequent bridge use removes the benefit.

## Compatibility

This runtime has a different host environment. Node globals, native modules, process mutation, custom reporters and arbitrary Node fixtures do not become browser-compatible through bundling. Require a declared supported module/API graph, reject unsupported code before execution where possible, and retain ordinary Node execution. Never rerun a partly executed test in Node as a fallback.

Specify timers, module identity, exceptions, stacks and source maps. Preserve assertion timeout/negation, retries, hooks, trusted events, cancellation, tracing phases and per-test state. Keep an external watchdog able to terminate a hung automation runtime. Application code must not obtain its privileged bridge or alter the test's builtins.

Document the execution target and its supported contract in README. It cannot contribute to claims that every existing Node test runs unchanged. A custom browser build needs explicit version negotiation and ordinary-browser selection as the opt-out.

## Payoff and later decision

The target is host/browser transport and repeated host scheduling per operation, not application work. Existing measurements in ideas 01 and 03 already limit the upside on ordinary local TodoMVC. The case must therefore come from command-dense or high-latency workloads, not a promised universal multiplier.

First compare a browser-hosted read/assertion loop with the same Node test colocated beside the browser, including module load and reporting. Also compare [complete remote workers](38-live-cross-machine-worker-queue.md). If ordinary colocation removes the latency just as well, prefer it.

Later test event/microtask order, navigation, frames, cancellation and source locations across the supported subset. Run upstream `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src` in normal mode, plus a dedicated runtime conformance corpus. Keep full `node bench/matrix.mjs` controls and report this mode separately under the [shared evaluation rules](01-browser-native-actions.md#payoff-and-decision-test). No browser development on the busy machine.
