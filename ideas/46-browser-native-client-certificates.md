# Present client certificates in the browser instead of relaying TLS through Node

Scope: applications using mutual TLS through `clientCertificates`. Effort: very large across browsers; a Chromium-only first version is smaller. Priority: high for certificate-heavy enterprise suites.

Research, 2026-10-31, against `c4c3583b` and the live worktree. No network traffic or benchmarks generated.

## Where the work is

[`ClientCertificatesProxy`](../packages/playwright-core/src/server/socksClientCertificatesInterceptor.ts) implements browser client certificates through a SOCKS proxy. For configured certificate origins, `_establishTlsTunnel` opens upstream TLS with the client certificate, terminates a separate browser-facing TLS connection, and pipes plaintext between them. The extra TLS leg and Node data relay remain throughout the connection.

The current code already passes unconfigured origins through without terminating TLS. Do not propose that optimization again. [Idea 29](29-multiplexed-api-http2.md) changes standalone APIRequest transport; this proposal concerns the browser's own page, frame and worker traffic.

## Proposed change

Install an origin-scoped certificate provider on the browser context. At a server client-certificate challenge, select the configured identity and supply it to the browser network service. The browser then owns the end-to-end TLS connection, so response bodies no longer traverse an additional decrypt/encrypt relay in Node.

Chromium already has certificate selection and private-key signing interfaces. Its [URL loader observer](https://chromium.googlesource.com/chromium/src/+/HEAD/remoting/base/url_loader_network_service_observer.cc) demonstrates responding to a certificate request, and [ClientCertificateResponder](https://chromium.googlesource.com/chromium/src/+/d20f64b9ae657cbafc5811b2e8a9a3ec8c376438/services/network/public/mojom/network_context.mojom) supplies a certificate and signing interface. This establishes an integration route, not a Playwright-ready context API.

Start with PEM identities on Chromium and exact configured origin matching. Either import the identity into an ephemeral context-owned provider or retain a signing service that handles handshake signatures only. The latter keeps bulk application traffic out of Node without requiring private-key export into every process. Add PFX/passphrase and platform-specific support later.

Preserve an explicitly configured upstream proxy. Removing the certificate implementation's local relay is not permission to bypass the user's network route. Dispose certificate providers, selection caches and associated pooled connections when their context expires or changes identity.

## Compatibility boundary

Native TLS can change the server-observed ClientHello, negotiated algorithms, certificate validation errors, response security details and session reuse. The current proxy can also turn some upstream failures into an HTTP error page. Therefore ship this first as an explicit native-certificate mode with documented differences and the existing proxy as fallback, selected before requests start.

Preserve exact origin/port matching, no-certificate behavior, redirects, authentication, cancellation, `ignoreHTTPSErrors` policy and context isolation. Never reuse an authenticated connection under another context's identity, including through HTTP/2 origin coalescing. Service workers and popups must use their owning context's provider.

Do not retry a request through the other mode after an ambiguous failure; a POST may already have executed. Unsupported browsers or key types use the existing path from the outset. Keep keys out of traces, persistent caches and logs.

## Payoff and first decision

The target is an extra TLS leg, relay buffering/copying and Node scheduling on every protected byte. Large mTLS responses and many concurrent protected requests offer more upside than one small warm request. Actual server latency remains; certificate-free suites gain nothing.

Later prototype one origin and compare handshake cost, sustained transfer and complete browser tests. Verify server-observed identities and request counts, certificate rotation, bad certificates, redirects, proxies, worker traffic and closing contexts with requests in flight.

Run client-certificate/proxy/network library coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report the full [benchmark matrix and scenario command](../bench/README.md), plus separate native/proxy mTLS workloads under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Count both browser and Node CPU/memory; build on separate capacity.
