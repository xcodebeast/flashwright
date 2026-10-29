# Multiplex concurrent API requests over isolated HTTP/2 sessions

**Scope:** APIRequest suites issuing concurrent HTTPS requests to HTTP/2 services. **Effort:** large. **Priority:** high potential for remote API workloads; explicit opt-in.

Research proposal, 2026-10-29. No measurements. [Segmented bodies](16-segmented-api-request-bodies.md) reduce copies; this changes the network transport and connection concurrency. It does not change browser-page networking, which is already browser-managed.

## Evidence

[`APIRequestContext._sendRequest`](../packages/playwright-core/src/server/fetch.ts) chooses Node's `http.request` or `https.request`. `_ensureAgent` already creates context-owned keep-alive agents; enabling keep-alive again is not an optimization. Parallel requests still use the HTTP/1 transport and its connection model.

[HTTP/2](https://datatracker.ietf.org/doc/html/rfc9113) permits multiple concurrent exchanges on one connection, with stream/connection flow control and negotiated concurrency limits. [Node exposes client sessions and request streams](https://nodejs.org/api/http2.html). These primitives establish feasibility, not superiority over several warm HTTP/1 sockets.

## Design

Add a transport adapter below the existing redirect, cookie, body, deadline and response-processing logic. In an explicit HTTP/2 mode, negotiate supported HTTPS origins and maintain a bounded session pool **per APIRequestContext**. Key sessions by origin, proxy route, TLS verification, client certificate and other connection-affecting settings. Do not share authenticated sessions across tests merely to save a handshake.

Honor peer stream limits, queue deadlines and per-stream cancellation. Limit aggregate buffered bytes so a fast sender cannot turn multiplexing into a memory spike. Preserve full-body completion before fetch resolves, as today. Requests remain concurrently scheduled only when user code issued them concurrently; never speculate across sequential awaits.

Fall back to HTTP/1 where negotiation establishes lack of support before sending the request. Proxies, unsupported authentication and connection-specific headers can initially use the old transport. GOAWAY and failed streams require precise replay rules: do not resend an ambiguous non-idempotent request simply because a session disappeared.

## Compatibility and payoff

Protocol version is observable. HTTP/2 changes header casing/connection fields, has no HTTP/1 reason phrase, and may trigger different server behavior. Therefore keep HTTP/1 as the default initially, document mappings and differences in README, and retain an explicit opt-out. This is a new supported transport mode, not an invisible replacement.

Preserve redirect limits/method rewriting, cookie visibility, auth policy, certificate handling, proxy bypass, request traces, duplicate response headers, decompression, disposal and deadline behavior. HAR timing fields need honest HTTP/2 mappings; inventing a TCP/TLS handshake for each stream would mislead users.

The upside is fewer simultaneous handshakes/sockets and better utilization for many small remote requests. A warm single sequential request may gain nothing. Stream limits, CPU-heavy compression, TCP packet loss and server scheduling can make one HTTP/2 session slower than several HTTP/1 connections. Pool policy must be measured, not assumed.

## Later decision test

Use controlled dual-protocol servers with concurrency, redirects, trailers, certificates, resets, GOAWAY and cancellation. Compare application results and server-observed request counts; no replay may duplicate a side effect. Measure cold/warm connections, real latency, full disposal, CPU and memory.

Later run APIRequest library coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report opt-in HTTP/2 scenarios separately beside unchanged `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and `node bench/matrix.mjs`, plus a current-fork HTTP/1 baseline under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No server or load generation now.
