# Reuse eligible API connections across fresh test request contexts

Scope: many short API tests contacting the same remote services. Effort: large. Potential: remove repeated TCP/TLS setup while keeping each test's cookies, responses and request options separate. Explicit opt-in is required.

**Assessed 2026-10-31:** deferred: reusing connections across tests is observable by the server, so it can only be opt-in.

Research proposal, 2026-10-31. No requests or measurements performed.

## Evidence and distinct opportunity

The [`request` fixture](../packages/playwright/src/index.ts) creates a new `APIRequestContext` for each test and disposes it afterwards. [`fetch.ts`](../packages/playwright-core/src/server/fetch.ts) already creates context-owned keep-alive agents. `_disposeImpl` destroys those agents and clears their state, so the next test cannot reuse their connections. This is intentional isolation, not a missing keep-alive flag. [Node's agent documentation](https://nodejs.org/api/http.html#agentdestroy) describes the socket lifetime involved.

[Idea 54](54-pooled-api-proxy-tunnels.md) pools tunnels within one context, and [idea 29](29-multiplexed-api-http2.md) multiplexes requests within one context. Neither crosses the fixture boundary. A suite with one HTTPS request per test gets little help from either form of within-context reuse.

## Proposed change

Add an explicit project setting declaring origins whose application state is independent of connection identity. A worker-owned transport pool leases eligible idle HTTP/1 connections to fresh logical API contexts. Keep cookie stores, authentication configuration, response bodies, logs, traces and disposal flags context-owned.

Start with direct connections to explicitly allowed origins, no proxy, client certificates, connection-oriented authentication or custom DNS hooks. Partition by complete TLS and transport identity, including verification policy, server name, client identity where later supported, destination and network configuration. Never key by hostname alone.

Return a connection only after its current response has fully completed under today's API semantics and its request listeners are detached. A partially consumed, errored, upgraded or canceled connection is destroyed. Disposal aborts the old context's active requests before returning any eligible idle sockets. The next owner must not receive old events or mutate an old request.

Implement the ownership distinction below the request lifecycle, with a new lease manager rather than scattered exceptions to `dispose()`. Bound idle sockets, total sockets and idle lifetime. Close the pool at worker teardown and on relevant environment changes. Keep ordinary per-context agents as the default and fallback.

## Compatibility boundary

Cross-test connection reuse is observable at the server. Applications may bind authentication, routing, rate limits or test state to a connection; tests may explicitly count connections. An empty cookie jar does not prove that sharing is safe. Require the origin declaration, document this difference in README and provide a per-project/per-test disable switch. Strict isolation must retain private transport ownership.

DNS changes, certificate rotation and backend restarts need the same care as any long-lived connection. An uncertain write must never be replayed just to rescue a stale pooled socket. Preserve configured retry behavior, timeout accounting, redirects and server-observed request counts. Report reused-connection timing honestly in HAR and logs.

## Payoff and later decision

For `T` tiny tests, the current path can pay approximately `T` connection setups; a lease pool could reduce that toward the number of concurrently needed connections. The wall-time opportunity grows with remote round-trip time and handshake cost. A suite already using one worker-scoped request context has little upside.

Later compare isolated and leased transport across controlled latency, mixed credentials, server restarts and cancellation. Check cookie/state isolation and exact request counts. Measure complete fixture setup/teardown, TLS CPU, descriptors and memory. Run APIRequest and runner suites plus the browser regression bar against pristine upstream. Report this opt-in mode separately beside the [full benchmark matrix](../bench/README.md) and current-fork controls. No remote load or server startup now.
