# Carry exposed-network traffic over a bounded binary tunnel

Scope: remote browsers using `BrowserType.connect({ exposeNetwork })`, especially asset-heavy apps, uploads and realtime traffic. Effort: large. Potential: remove encoding overhead and prevent application traffic from congesting the automation connection.

**Assessed 2026-10-31:** deferred: only `exposeNetwork` tunnels for remote browsers.

Research proposal, 2026-10-31. Source-backed design; no network experiments performed.

## Evidence and distinct opportunity

[`SocksInterceptor`](../packages/playwright-core/src/server/socksInterceptor.ts) forwards socket data through `SocksSupport` channel messages. Outgoing validators use `binary: 'toBase64'`; incoming events use `fromBase64`. Each outgoing chunk also gets a request ID tracked until its reply. [`SocksProxyHandler`](../packages/utils/socksProxy.ts) relays those bytes to local sockets.

This means the application's TCP traffic shares the Playwright message path with automation. Base64 expands a payload to approximately four bytes for every three input bytes before JSON framing. That overhead repeats even for already-compressed images, JavaScript and TLS records.

[Idea 15](15-binary-browser-protocol.md) concerns Node-to-Chromium CDP. [Idea 30](30-windowed-remote-artifact-streams.md) concerns completed artifacts. This is the client-to-server tunnel carrying live application network traffic, and it needs independent bidirectional flow control.

## Proposed change

Negotiate a binary network channel when the remote connection is established. Keep destination authorization and socket-open decisions on the existing control path. Associate the new channel with that authenticated connection using a short-lived capability; never expose an unauthenticated relay port.

Represent data as compact frames containing tunnel ID, socket ID, direction, sequence and byte length. Move raw payload bytes without base64. Use one bounded credit window per direction, plus a connection-wide byte budget. A receiving socket grants more credit as its writable buffer drains; the sender pauses the corresponding TCP reader when credit runs out. [Node's stream contract](https://nodejs.org/docs/latest-v22.x/api/stream.html) supplies the local backpressure primitives.

Start with a separate binary WebSocket using existing libraries. This isolates application payloads from control serialization, although both still share physical bandwidth. A multiplexed transport with independent streams is a later comparison, not a prerequisite. Use fair frame sizes so one download cannot monopolize the tunnel. The old JSON path remains available for incompatible peers or intermediaries.

## Compatibility boundary

Preserve the exposure pattern, loopback handling, DNS resolution location, destination ports, IPv4/IPv6 behavior and connection errors. TLS stays end to end; the tunnel need not decrypt application traffic.

TCP preserves byte order, not incoming chunk boundaries. Preserve every byte and order within each direction, including queued bytes before half-close. Distinguish FIN, reset, connection failure and whole-tunnel disconnect. Do not retry a broken application connection or replay uncertain writes. Closing the browser connection must close all associated sockets and release credits.

Control acknowledgements must not report a socket ready before it is connected. Cancel late opens after disposal. Bound pending opens as well as payload bytes. Keep protocol changes in new adapters with small marked integration hooks and explicit version negotiation.

## Payoff and later decision

Large transfers could save encoding CPU, temporary strings and wire bytes; small requests may benefit mainly from less queue interference. Local browsers and remote browsers without exposed networking get no gain. A second connection has startup and buffering costs that must be counted.

Later measure navigation and action latency during simultaneous uploads/downloads, slow receivers, many sockets and disconnects. Compare received bytes and server-observed requests exactly. Run browser-connect/exposed-network library tests, `tests/page` on `chromium-page` and runner regressions against pristine upstream. Report remote workload rows beside the [full local matrix](../bench/README.md), with a current-fork baseline, tunnel setup/cleanup, total CPU and peak buffered bytes. Do not generate traffic on this machine now.
