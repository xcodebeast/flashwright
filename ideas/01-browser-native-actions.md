# Move complete actions into the browser

**Priority:** high · **Scope:** most interaction-heavy suites · **Effort:** very large, including Chromium work.

**Status:** partly implemented. Done, without a browser change: fewer dependent browser exchanges per action, two round trips fewer per pointer action (`f19b5bb7`) and more batching in `501ec6ee`. Not done: one browser command per action, or moving the action into the browser.

**Measured 2026-10-30:** a click now sends 14 browser commands in about six dependent round trips of ~0.2 ms; fill sends 5, press 7, an assertion 1. Each input ends with the `Page.enable` barrier that makes a navigation it started visible before the call returns. Fusing two of the click's round trips would save ~0.4 ms per click (under 2% of a TodoMVC test); not done.

Research proposal, 2026-10-29. Source audit through `1aebba9e` plus the active worktree. No new measurements; proposed gains are hypotheses. The existing warm browser, context recycling, reactive waits, scroll/measurement pipelining and opt-in worker/browser sharing are the baseline.

## Remaining cost

[`ElementHandle._performPointerAction`](../packages/playwright-core/src/server/dom.ts) still coordinates state checks, scrolling, geometry, frame hit testing, a hit-target interceptor, input and interceptor disposal through separate browser operations. [`Frame._retryWithProgressIfNotConnected`](../packages/playwright-core/src/server/frames.ts) adds selector resolution and retry control. [`CRSession.send`](../packages/playwright-core/src/server/chromium/crConnection.ts) creates a request/callback pair for each command; [`PipeTransport`](../packages/playwright-core/src/server/pipeTransport.ts) serializes JSON and schedules received messages with `setImmediate`.

Recent Flashwright batching overlaps some commands. It cannot remove exchanges whose next step depends on the previous result. Rewriting the pipe in Rust would leave those dependencies intact.

## Proposed mechanism

Introduce a versioned browser command for one complete public action, initially a main-frame locator click. Send the parsed selector, options, deadline and cancellation token once. A browser-side state machine resolves the element, checks the required states, scrolls, computes geometry, installs interception and dispatches **trusted input through Chromium's existing input pipeline**. It returns the result plus a compact diagnostic record.

This is a continuation that lives beside the browser scheduler, not an atomic block of JavaScript. Keep required task checkpoints, rendering updates, input acknowledgements and navigation barriers. Yield to Node whenever execution needs a locator handler, route callback, debugger intervention or other user code. Never batch across two public `await` boundaries speculatively.

Stage the work:

1. Fuse selector resolution and page-side readiness/geometry preparation using the current injected implementation, leaving trusted input in Node. This establishes the available round-trip savings without a browser fork.
2. Move the remaining action state machine behind a narrow Chromium automation interface. Reuse Flashwright's selector semantics; native DOM/AX queries are not automatically equivalent to Playwright locators.
3. Extend to fill, press, hover and frame trees only after the first action is compatible. Keep stock CDP as the fallback for unsupported browsers/options and explicit troubleshooting.

## Functional contract

Preserve strict-selector errors, detachment retries, actionability, `force`, `trial`, modifier restoration, input event order, navigation waiting, cancellation and timeout accounting. `waitForAnimations: true` must still work. A canceled command must not emit input later. Trace phases, API logs and user instrumentation must retain their logical positions; buffer observations, not user callbacks. Out-of-process frames need explicit coordination rather than pretending the page has one renderer.

## Payoff and decision test

**First experiment:** fuse only selector resolution and state checks for an ordinary main-frame click. Keep trusted input, tracing and navigation handling unchanged. Count dependent exchanges and time from API entry to completion; fewer messages alone does not prove a faster action.

If an action currently needs `k` dependent exchanges with scheduling cost `r`, the removable component is approximately `(k - new_k) × r`, plus serialization and handle churn. This is a model, not a measured bound: browser work and host callbacks remain. The benefit repeats on every action and should matter most for local fast applications and remote browser connections. Fewer messages and handles should also lower CPU and allocation pressure.

When the machine is free, attribute dependent exchanges on TodoMVC, shop, iframe and interaction workloads. Compare the current fork with the candidate, then run `node bench/run.mjs todomvc 1 15 stock,fork` and the **whole** `node bench/matrix.mjs 15`; include four-worker and remote-latency cases. Use the [benchmark procedure](../bench/README.md), including `BASE_DIR` for the old-fork comparison. Run `tests/page` on `chromium-page`, relevant library/input tests and `tests/playwright-test` if reporting changes; compare failures against pristine upstream built in `workbench/pw-src` on the same machine. Reject a command-count win that does not improve complete-suite wall time or changes observable behavior.

The same evaluation rule applies to the other proposals: include preparation, fallback and final cleanup costs; report CPU and concurrent memory alongside the full timing matrix. Do not run these experiments while the current benchmark work is occupying the machine.

Priorities are engineering judgments, not measured rankings. If a candidate targets fraction `f` of a run, even removing that work entirely gives a serial upper bound of `1 / (1 - f)`; parallel runs require critical-path attribution. Savings from these proposals can overlap and must not be added together.

For implementation, keep new machinery in new files or generated adapters, with small upstream hooks marked `Flashwright:`. Browser extensions need explicit version negotiation and a stock-browser fallback. Document any observation differences and their opt-outs in README; a candidate that cannot preserve its stated contract is not an optimization to ship.
