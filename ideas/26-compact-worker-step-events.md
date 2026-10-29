# Encode worker step events once in a compact ordered stream

**Scope:** suites with many API calls, assertions, hooks or explicit test.step calls. **Effort:** large. **Priority:** promising for very short, step-dense tests.

Research proposal, 2026-10-29. No measurements. [Incremental reports](20-incremental-test-report-generation.md) optimize report consumers and final assembly. This targets the earlier worker-to-runner IPC path, even when no HTML/blob report is requested.

## Evidence

[`TestInfoImpl._addStep`](../packages/playwright/src/worker/testInfo.ts) builds a step with stack, children, attachment indices, TestStepInfo and completion closure, then emits begin/end payloads. [`WorkerMain`](../packages/playwright/src/worker/workerMain.ts) forwards those as individual events. [`JobDispatcher._onStepBegin/_onStepEnd`](../packages/playwright/src/runner/dispatcher.ts) reconstructs a second step representation and calls reporters.

The fork already avoids some historical-step searches through `_unfinishedPredefinedSteps`; that is not the proposed optimization. The remaining repeated metadata, message envelopes and serialization scale with **steps**, not test count. The [local dispatch proposal](03-generated-in-process-dispatch.md) concerns a different client/server boundary inside the automation library.

## Design

Add a versioned worker-event codec with compact numeric event tags and per-worker dictionaries for repeated file locations, categories and immutable strings. Encode parent/step identity and mutable values per event. Reconstruct the exact existing payload before passing it into JobDispatcher, so public reporter objects and callback order stay intact.

Begin with immediate sends: remove repeated representation without changing delivery cadence. Dictionary additions must precede references on the same ordered channel. Dictionaries reset with worker identity/restart and need byte/count limits; arbitrary user titles can otherwise grow without bound. Include lane identity for `workersPerProcess`.

Only then investigate bounded coalescing for known built-in consumers. Flush before test-end, errors, attachments, stdout/stderr ordering boundaries, pause/stop acknowledgements and worker exit. Custom reporters, UI/debugging and unknown consumers retain immediate delivery unless an explicitly documented batching mode is selected. A generic delay timer is not a free optimization: callbacks can influence external systems while a test runs.

## Compatibility and payoff

Preserve timestamps captured at the source, parent links, retries, soft errors, annotations, boxed stacks, attachments and late-event handling. Do not eliminate the runner's public step tree merely because a built-in reporter does not display it: custom reporters can retain and inspect those objects. Avoid lazy property facades that change enumeration, identity or mutation behavior.

A crashed worker must not leave required preceding events only in a private unsent buffer. Preserve current best-effort crash diagnostics, and never hold a test-end acknowledgement while silently dropping steps. Bound IPC queues and honor backpressure without starving control events.

Expected savings are IPC serialization bytes, envelope count where batching is permitted, and transient metadata allocations. Persistent step trees still exist. Compression CPU or dictionary overhead may lose for small suites, so retain the simple codec below a justified threshold. No claim that all step instrumentation can disappear.

## Later decision test

Record decoded event sequences and custom reporter observations for the reference and candidate, including stdout, crashes, retries, interruption and shared-process lanes. Measure end-to-end time, IPC volume, queue peak and GC on step-heavy suites; include tracing off/on and slow reporters.

Later run step/reporter/worker coverage in `tests/playwright-test`, `tests/page` on `chromium-page`, and compare failures with pristine upstream in `workbench/pw-src`. Report `node bench/run.mjs <scenario> <workers> <iterations> stock,fork`, the entire `node bench/matrix.mjs` and a current-fork baseline under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Defer execution until the machine is free.
