# Give page-to-Node bindings a native request and reply channel

Scope: instrumentation, component callbacks and applications that call exposed functions thousands of times. Effort: very large for browser integration. Compatibility: existing binding APIs and Node callback execution.

**Assessed 2026-10-31:** deferred: only pages that call exposed functions thousands of times, and it needs browser integration.

Research, 2026-10-31, against `1f613889` and the live worktree. No callback-load tests run.

## Evidence and distinction

[`BindingsController.callBinding`](../packages/injected/src/bindingsController.ts) serializes every argument, JSON-stringifies a wrapper and invokes the browser binding. [`PageBinding.dispatch`](../packages/playwright-core/src/server/page.ts) parses that payload, calls the Node function, then starts `evaluateExpressionHandle` to deliver each result or error to the page. Chromium uses `Runtime.addBinding`; the [local protocol](../packages/playwright-core/src/server/chromium/protocol.d.ts) defines its string payload.

Each callback therefore incurs both an outgoing inspector event and a generic evaluation for completion. [Idea 24](24-packed-evaluation-values.md) improves value encoding but leaves this request/reply lifecycle. [Idea 56](56-browser-local-websocket-forwarding.md) removes callbacks for untouched socket traffic. Here the callback is required user code and must still execute in Node.

## Design

Add a versioned browser binding endpoint with per-document request IDs and a native completion operation. The page creates its normal promise, serializes arguments under Playwright's rules and submits a structured record. Node invokes the same callback. Its completion record resolves or rejects the original promise through the registered endpoint, avoiding a fresh generic `Runtime.callFunctionOn` evaluation and temporary result handle.

Use bounded binary queues for substantial payloads; small records can share the negotiated control transport. Reuse a compatible value codec if idea 24 exists, but measure the benefit of native completion separately. Do not require that proposal to justify this one.

Keep requests immediate initially. Combine only physical writes that are already queued, while dispatching each logical call and completion at its required task/microtask boundary. A deliberate batch-delay timer could change callback latency and hide application races.

## Functional boundary

The callback stays in the test process, with the same page/frame/context argument, async execution and exception handling. Preserve argument traversal, getters, cycles and supported value semantics. Generic structured clone is not a substitute for Playwright serialization.

Permit out-of-order completion when callbacks finish out of order. Bind every record to execution-context and binding-registration identity so a reply cannot resolve a promise in a later document or replacement binding. Navigation, binding removal, page close and worker failure must clear pending native roots without delivering late callbacks.

Backpressure must not silently drop invocations or synchronously block the renderer while Node waits on that renderer. Retain the old path wherever compatibility, debugger behavior or platform support is uncertain. Inspect current quirks around altered serialization builtins rather than assuming a new codec is invisible.

## Payoff and later decision

The target is per-callback inspector dispatch, generic evaluation, intermediate strings and handle bookkeeping. Slow Node callbacks remain slow. This is a throughput opportunity for callback-heavy suites, not a predicted win for ordinary locator tests.

Later compare scalar calls, large values, concurrent callbacks and callback-to-page reentrancy. Verify invocation/completion order, errors and navigation cleanup. Measure end-to-end test time and bounded-queue memory alongside callback throughput. Run binding/frame coverage, `tests/page` on `chromium-page`, relevant `tests/playwright-test` cases and the [full matrix/current-fork comparison](01-browser-native-actions.md#payoff-and-decision-test) against pristine upstream.
