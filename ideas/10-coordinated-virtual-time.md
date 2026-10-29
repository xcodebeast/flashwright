# Advance application time while the test is waiting

**Priority:** moonshot, explicit opt-in · **Scope:** timer-heavy tests in a controlled environment · **Effort:** very large.

Research proposal, 2026-10-29. No new performance claims. Unlike the other proposals, this deliberately introduces a simulated-time test environment. It cannot transparently accelerate arbitrary existing suites.

## Remaining cost

Reactive waits wake promptly when a page changes, but cannot eliminate a real 300 ms debounce, a seconds-long retry backoff or an expiry timer. `instantAnimations` addresses one narrower case. [`Clock`](../packages/playwright-core/src/server/clock.ts) and the [injected clock](../packages/injected/src/clock.ts) expose manual time control, but do not automatically coordinate browser/Node/server progress while assertions are waiting.

Chromium's [virtual-time controller](https://chromium.googlesource.com/chromium/src/+/ebc820cbbf252f860649aa16848617f99f5b2972/third_party/blink/renderer/core/inspector/inspector_emulation_agent.cc) offers policies including advancing virtual time and pausing around network loading. That does **not** establish global quiescence across Node, workers, sockets and an external server.

## Proposed mechanism

Offer an explicit project/test mode whose time domain is simulated from the start of the attempt. While test code awaits a browser assertion or action, a coordinator advances to the next relevant virtual timer/rendering deadline instead of sleeping for the corresponding wall duration. Run due tasks and their microtasks in order, reevaluate the awaited condition at the required checkpoints, and stop advancing as soon as it is satisfied.

Start with one page, known frames, no workers/media/sockets, no external server deadlines and a controlled mocked backend. Integrate with the existing clock through a separate internal driver; do not change `clock.fastForward()` semantics, which may intentionally skip repeated timer firings. A later extension could include an opt-in Node/server clock adapter so application and fixture timers share an ordered time domain.

Advance only with explicit participation or a conservative barrier from every producer that can change the result. In-flight real I/O blocks jumps; a scheduled Node callback that will call `page.evaluate()` must also be accounted for. Open sockets, uncoordinated workers and unknown native callbacks make the initial mode unsupported. The current [`IdleDetector`](../packages/playwright-core/src/server/idleDetector.ts) cannot prove this: its page instrumentation has known limits concerning future host-side actions.

## Functional contract and difference

An explicit declaration accepts synthetic elapsed time and its interaction with wall-clock services. `Date`, `performance`, timers, animation frames and event timestamps need a coherent documented mapping; real HTTP expiry, tokens and backend clocks must not be silently shifted. Preserve logical timer ordering, interval firings, microtask checkpoints, cancellation and rendering checkpoints. Infinite timers still need a bounded policy.

Keep test-runner safety timeouts on a real watchdog; define assertion/application virtual budgets separately. Explain both clocks in traces and failure messages. Refuse unsupported configurations before execution where possible. If an uncoordinated producer appears after time has advanced, fail with a clear unsupported-mode error rather than silently switching back to wall time and pretending the prior execution was unchanged.

Ordinary execution remains available by disabling the mode. Document its observation differences in README before release. It is appropriate for logic validated against controlled time, not a substitute for real-time/media/server integration tests.

## Payoff and decision test

**First experiment:** use one mocked page with a debounce and repeating retry timer. Compare callback/microtask order against manually advancing the existing clock by the same logical deadlines. Then introduce a Node timer that changes the page: the coordinator must account for it or reject the unsupported execution.

The target is removing wall-clock sleeps while still executing the application's scheduled work. Timer-heavy suites have a much larger potential ceiling than pure dispatch optimization; compute-bound code and actual backend latency are unaffected. CPU per callback is not inherently reduced, and coordination adds overhead. Scope limitations are material, so do not include this mode in drop-in compatibility/speed claims.

Later compare a controlled debounce/retry/expiry corpus against an explicitly controlled-time reference, checking full callback/event sequences, not only final DOM state. Test adversarial Node callbacks and unsupported producers. Report this separately, alongside the unchanged full [stock/fork matrix](01-browser-native-actions.md#payoff-and-decision-test). Run upstream `tests/page` on `chromium-page` and `tests/playwright-test` in normal mode against pristine upstream; run clock-specific coverage and the dedicated supported-mode corpus with acceleration enabled. Reject any claimed speedup that skips a callback, swallows an external event or changes a result within the declared simulated-time contract.
