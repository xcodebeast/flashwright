# Forward untouched routed WebSocket messages inside the browser

Scope: realtime applications using WebSocket routing, especially one-direction inspection and remote drivers. Effort: large. Priority: high potential for message-heavy suites; requires an explicit fixed forwarding contract initially.

**Assessed 2026-10-31:** deferred: only suites that route WebSockets.

Research, 2026-10-31, against `95f3e831` and the live worktree. No sockets opened or traffic generated.

## Evidence and distinct opportunity

[`WebSocketRoute`](../packages/playwright-core/src/client/network.ts) forwards `messageFromPage` back through `sendToServer` when connected without a page-message handler. It similarly forwards server messages through `sendToPage` when no server handler exists. The [dispatcher](../packages/playwright-core/src/server/dispatchers/webSocketRouteDispatcher.ts) uses a page binding for incoming messages and evaluates a page expression for outgoing messages. Untouched payloads therefore travel browser → Node → browser, including base64 conversion for binary data.

[`webSocketMock.ts`](../packages/injected/src/webSocketMock.ts) already has `_apiPassThrough` for sockets that match no route. That is implemented and is not this proposal. The gap is a routed socket whose handler calls `connectToServer`, but leaves one or both message directions on automatic forwarding. The [public API](https://playwright.dev/docs/api/class-websocketroute#web-socket-route-connect-to-server) explicitly supports automatic forwarding until message handlers are installed.

This removes a data-path round trip. [Idea 14](14-browser-event-subscriptions.md) concerns optional diagnostic traffic; this path carries the application's actual messages.

## Proposed change

Add independent browser-side forwarding modes for page-to-server and server-to-page messages. At a declared configuration boundary, install the selected modes before releasing buffered traffic. The existing native WebSocket still owns the real connection; the mock delivers the same application events. Keep the route object alive for sends, closes and handled directions.

Start with an explicit declaration that the selected direction will remain unhandled for the socket's lifetime. A one-way mock could inspect client messages in Node while server updates stay local. Fully untouched routed connections can forward both directions locally. Do not infer permanent absence from an empty handler field at one instant.

Retain close handling through the existing path initially, with sequence barriers that drain preceding messages before a close is applied. Preserve message order across explicit `send` calls, locally forwarded messages and Blob conversion. Avoid converting binary messages to base64 when they remain inside the browser.

## Compatibility boundary

The hard case is late `onMessage` registration. Today a message reaches Node before the currently installed callback is chosen. A local path could already have delivered that same message. A generation number alone cannot recover this observation. Therefore keep ordinary dynamic routing unchanged; reject late handler installation on a direction explicitly frozen for local forwarding, with the restriction documented and an opt-out.

Preserve connection establishment, subprotocols, binaryType, text/binary payloads, explicit sends, close codes/reasons, navigation and context cleanup. Keep separate ownership for each socket. Bound configuration-time buffers and propagate failure; a detached frame cannot leave a producer sending into an abandoned queue.

Check public WebSocket frame events, tracing and route instrumentation separately. Consumers that require the old forwarded event sequence must retain the old path until the local mode can supply their observations. Do not silently discard diagnostics or change a mock into an unobserved network connection.

## Payoff and later decision

The target is two automation crossings and binary expansion per untouched message. Collaborative editors, streaming dashboards and binary feeds can issue enough messages for this to dominate. Sparse chat tests may gain nothing. It does not accelerate messages that arbitrary Node callbacks must inspect.

Later compare fixed one-way and two-way forwarding with today's route path, locally and at controlled remote latency. Verify payloads, order, mixed Blob/buffer sends, close races and the declared late-handler error. Measure application-observed completion, CPU and queue peaks, not just messages per second.

Run WebSocket routing/frame/trace coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report the explicit mode separately beside the full [matrix](../bench/README.md), following the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No validation traffic now.
