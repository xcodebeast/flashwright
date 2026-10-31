# Reuse decompression work while verifying every new response byte

Scope: repeated large compressed assets across fresh tests and browser workers. Effort: monumental for a streaming implementation. Compatibility: normal requests, response bytes and failure behavior remain intact.

**Assessed 2026-10-31:** deferred: browser network-stack work.

Research, 2026-10-31, against `1f613889` and Chromium main. No compression probes or network workloads.

## Evidence and distinction

Chromium's [`GzipSourceStream`](https://raw.githubusercontent.com/chromium/chromium/main/net/filter/gzip_source_stream.cc) maintains per-stream decode state and calls native inflate as encoded input arrives. Browser HTTP/resource caches can already avoid some work. Flashwright's [`clearCache`](../packages/playwright-core/src/server/chromium/crNetworkManager.ts) intentionally clears memory caches at isolation boundaries, and routed traffic can disable caching.

Repeated tests may therefore receive and decompress identical bytes again even when they must make fresh requests. [Idea 61](61-batched-native-response-decompression.md) accelerates Node API-request codecs. This proposal removes repeated browser decompression through verified reuse; it does not substitute a faster inflate implementation. [Idea 19](19-portable-application-bytecode-cache.md) acts later, after script source exists.

## Design

Build a bounded native cache containing an eligible response's encoded bytes, decoded segments and checkpoints recording how much encoded input was sufficient to produce each segment. Use URL/validators only to find candidates. Exact incoming-byte comparison establishes reuse; headers or a repeated URL never authorize serving cached decoded data.

On a matching prefix, release only decoded segments justified by bytes received for this request. Keep the ordinary stream's backpressure and completion rules. Validate the entire encoded stream before reporting successful completion. No response may finish early because an older response had the expected suffix.

If the incoming bytes diverge, resume the ordinary decoder from a compatible checkpoint. If safe codec-state restoration is unavailable, replay the verified compressed prefix into a fresh decoder while discarding output already delivered, then continue normally. That fallback can be expensive, so repeated mismatches must disable reuse for that workload.

First prototype one codec and a narrow complete-response path where buffering already exists. Full-body matching must not replace streaming for ordinary scripts or fetch readers. A production streaming version needs explicit proof of prefix/output correspondence, not guessed compression-block boundaries.

## Functional boundary

Every request still reaches routing/network/authentication normally. Apply cookies, redirects, headers and policy checks independently. Share only derived byte content, never request state. Private project/origin partitioning and decoder-version identity remain part of cache ownership.

Preserve corrupt/truncated-stream errors, trailing-data rules, cancellation, decoded-size limits and multiple content-encoding layers. Never emit a decoded byte before the currently verified input is sufficient to determine it. Do not infer completion or integrity from an earlier successful stream.

Bound encoded plus decoded storage and metadata together. Highly compressible bodies can make this cache much larger than the wire traffic. Small or unique bodies keep the ordinary native decoder. Match the packaged browser's actual codec behavior before extending beyond the first supported format.

## Payoff and later decision

The target is replacing repeated inflation with compressed-byte verification and decoded-buffer reads. It cannot remove network delay or application parsing. The gain requires expensive repeated decompression and cheap reuse; memory bandwidth, cache misses or fallback replay can make it slower.

Later compare full-suite timing for repeated, unique and late-diverging compressed assets, including slow streams and malformed endings. Count all bytes retained, verification CPU and fallback work. Run codec tests, network/routing regressions, `tests/page` on `chromium-page` and runner tests against pristine upstream, plus the [full matrix/current-fork comparison](01-browser-native-actions.md#payoff-and-decision-test). Keep this exploratory until it beats existing native decoding end to end.
