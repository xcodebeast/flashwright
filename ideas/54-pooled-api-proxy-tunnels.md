# Reuse API proxy tunnels within each request context

Scope: APIRequest tests and `route.fetch()` through HTTP or SOCKS proxies. Effort: medium to large. Priority: strong candidate for repeated requests over distant proxies.

**Assessed 2026-10-31:** deferred: only API tests that go through a proxy.

Research, 2026-10-31, against `95f3e831` and the live worktree. No requests, proxy processes or timing runs were started.

## Evidence and distinct opportunity

[`APIRequestContext._sendRequest`](../packages/playwright-core/src/server/fetch.ts) calls `createProxyAgent(...)` for each request attempt. [`createProxyAgent`](../packages/utils/network.ts) constructs a new `HttpsProxyAgent` or `SocksProxyAgent`. Direct connections already use context-owned keep-alive agents through `_ensureAgent`; the proxy path bypasses that reuse and creates no comparable context-owned pool.

The installed proxy packages are `https-proxy-agent` 9.1.0 and `socks-proxy-agent` 10.1.0. The [HTTP proxy agent's source](https://github.com/TooTallNate/proxy-agents/blob/main/packages/https-proxy-agent/src/index.ts) accepts agent options and establishes CONNECT tunnels. A retained agent with keep-alive is a feasible building block, not proof of a speedup or sufficient connection-key isolation.

[Idea 29](29-multiplexed-api-http2.md) changes HTTP versions. [Idea 46](46-browser-native-client-certificates.md) removes the browser's certificate relay. This proposal retains the current HTTP/1 and proxy protocol and avoids repeatedly rebuilding eligible connections inside one APIRequestContext.

## Proposed change

Add a proxy-agent registry owned and disposed by APIRequestContext. Evaluate bypass rules on each destination, including redirects, then select the direct agent or a retained proxy agent. Enable keep-alive explicitly and bound idle sockets, active sockets and total agents.

Partition by proxy type/address/credentials and destination connection identity. Audit the installed agent's socket key: destination host/port alone may be insufficient when TLS settings differ. Verification policy, server name, client identity and other connection-affecting options must prevent incompatible reuse. Conservative separate agents are preferable to an overly broad pool.

Keep SOCKS remote DNS behavior: the current helper deliberately maps `socks5` to `socks5h` and `socks4` to `socks4a`. Preserve CONNECT for HTTP destinations initially; the helper's comment about changing that behavior is a separate issue.

Destroy all leased and idle tunnels at context disposal. A failed connection must leave no reusable half-authenticated socket. Apply the current timeout across queueing, tunnel establishment and response completion. Keep existing retry limits; a stale keep-alive socket is not permission to replay an ambiguous side-effecting request.

## Compatibility boundary

Do not share tunnels across API contexts, workers or test attempts with different request fixtures. Preserve proxy authorization, origin authorization, bypass, redirects, certificate validation, response security details and cancellation. Request-specific options must not be accidentally overridden by defaults stored in an agent.

Connection reuse is visible to the proxy and server, as direct keep-alive already is. Suites that deliberately inspect connection counts or depend on connection-scoped proxy state need a fresh-tunnel option. Initially expose a clearly documented reuse policy and retain today's behavior as the opt-out; do not count opt-in results as an automatic improvement for every suite.

## Payoff and later decision

Repeated small requests can avoid proxy TCP/TLS setup, CONNECT or SOCKS negotiation, and destination TLS handshakes. The opportunity is roughly the avoided setup on each reusable connection, not the service's application latency. One request per context, proxies that close every tunnel and heavily parallel requests with no reuse gain little.

Later compare cold and reused tunnels for sequential/concurrent HTTP and HTTPS requests, proxy authentication, bypass redirects, server closes and disposal. Count actual connections at both proxy and destination, complete request/run time, CPU and open descriptors. Test TLS identity changes within one context explicitly.

Run APIRequest/proxy/client-certificate coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Add proxy workloads beside the full [matrix](../bench/README.md), with current-fork comparisons and all cleanup included under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No validation runs now.
