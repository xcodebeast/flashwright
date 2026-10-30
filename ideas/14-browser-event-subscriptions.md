# Keep unobserved diagnostic traffic inside the browser

**Scope:** applications with many requests, console messages or WebSocket frames. **Effort:** very large for full browser integration. **Priority:** promising for event-heavy workloads.

**Measured 2026-10-30:** a TodoMVC test receives ~85 protocol events; their Node cost does not show among the worker's top functions. Not pursued for typical suites.

Research proposal, 2026-10-29. No benchmarks. This removes unnecessary diagnostic transport; it does not block application resources or disable browser capabilities.

## Evidence and opportunity

[`CRNetworkManager.addSession`](../packages/playwright-core/src/server/chromium/crNetworkManager.ts) enables Network and installs request, response, extra-info and WebSocket listeners. [`CRPage`](../packages/playwright-core/src/server/chromium/crPage.ts) receives Runtime console and execution-context events. By the time [`BrowserContextDispatcher._shouldDispatchEvent`](../packages/playwright-core/src/server/dispatchers/browserContextDispatcher.ts) checks client subscriptions, browser-to-Node serialization and much server-side object construction have happened.

Blindly turning domains off is incorrect. [`Page`](../packages/playwright-core/src/server/page.ts) retains recent requests, console messages and errors for later retrieval. Navigation, routing, idle detection, traces, HAR and internal console interception also consume information without a user listener. The opportunity is to move filtering **and required retention** earlier, not delete those semantics.

## Design

Build a consumer registry that combines public subscriptions with internal dependencies. Distinguish essential lifecycle/control events from optional diagnostic details. First avoid proven-unneeded Node enrichment or duplicate conversion while retaining all event delivery. Then add a versioned browser extension that keeps the required bounded history locally and emits detail only for active consumers.

The browser still sends navigation identities, request completion and other signals required for correctness. For eligible diagnostics it stores structured records/handles with the same retention limits and navigation marks as today's Page buffers. A later history API materializes the same public objects. Live subscriptions switch to immediate ordered forwarding; tracing, HAR and debugging can request the existing full stream.

Begin with one narrowly defined diagnostic class. Console history is an instructive candidate but difficult: argument handles, exceptions and internal console signals must survive appropriately. Network histories require redirect chains, bodies, security/timing details and service-worker associations. Unsupported categories remain unchanged rather than being approximated.

## Compatibility boundary

Listener registration is synchronous at the public API. Define the same effective ordering as today's subscription messages, including queued events and a listener immediately followed by an action. Sequence numbers and a registration barrier must prevent gaps or duplicates while switching between retention and live delivery. Do not replay old events to a listener that only requested future events.

Preserve console argument behavior, request identity, waits, navigation responses, errors, traces and recent-history APIs. Maintain internal idle/control consumers even when all user listeners are absent. Browser buffers must release remote handles on eviction/reset and stay within bounded memory. This proposal intends no functional difference; a custom browser is acceptable only with negotiation and a stock fallback.

## Payoff and later validation

Savings scale with unconsumed event volume and payload size, reducing browser serialization, pipe traffic, Node allocations and GC. Quiet apps or traced runs may gain little. Local browser retention may merely move memory; measure both processes.

First map consumers for one category, then compare exact live/history sequences under listener churn, navigation, popups, workers and resets. Measure listener-free versus listener-heavy traffic, with traces off/on. Never claim wins from losing diagnostics.

Later add an event-heavy corpus alongside `node bench/matrix.mjs 15` and `node bench/run.mjs todomvc 1 15 stock,fork`; compare the current fork separately. Run `tests/page` on `chromium-page`, library network/console/WebSocket/tracing tests and `tests/playwright-test`, against pristine upstream in `workbench/pw-src`. Follow the [shared measurement and small-hook rules](01-browser-native-actions.md#payoff-and-decision-test).
