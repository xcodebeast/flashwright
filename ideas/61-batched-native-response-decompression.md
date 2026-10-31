# Decode large API responses with fewer codec dispatches and faster native kernels

Scope: large compressed API responses, `route.fetch()` and concurrent API suites. Effort: medium for buffer tuning; very large for a portable native codec adapter. Priority: promising for compressed-data workloads, conditional on the installed Node codec.

**Assessed 2026-10-31:** deferred: only large compressed API responses.

Research, 2026-10-31, against `95f3e831` and the live worktree. No payloads decompressed, native modules built or performance probes run.

## Evidence and distinct opportunity

[`APIRequestContext._sendRequest`](../packages/playwright-core/src/server/fetch.ts) creates Gunzip, BrotliDecompress or Inflate streams, receives decoded chunks and concatenates them before resolving. It sets flush behavior for gzip/Brotli but leaves output chunk size at Node's default. [Node 22's zlib documentation](https://github.com/nodejs/node/blob/v22.x/doc/api/zlib.md#class-options) describes a default 16 KiB chunk size and asynchronous thread-pool execution.

The codec is already native. The opportunity is fewer transitions and allocations per decoded megabyte, plus a faster compatible implementation where the installed runtime leaves room. [zlib-ng](https://github.com/zlib-ng/zlib-ng) offers CPU-specific optimizations and a zlib compatibility mode; its own performance claims do not establish superiority over this machine's Node build.

[Idea 16](16-segmented-api-request-bodies.md) changes body ownership and concatenation. This changes the decompression stage that must still finish before a response is returned. [Idea 55](55-trace-archive-compressed-splicing.md) removes redundant archive recompression, a different workload.

## Proposed change

First try larger bounded codec output buffers for large responses, such as 64 or 256 KiB, while keeping the same Node codec and flush options. Keep the small-response path cheap. Use actual observed output and hard memory budgets; compressed Content-Length does not reveal decoded size. Avoid artificially waiting for a large input batch while network data is available.

Then evaluate a lazily loaded native streaming adapter for gzip/deflate only. Keep Brotli on its present path initially. Compare CPU-dispatched kernels with the runtime's existing optimized zlib, using the exact same stream semantics. Feed bounded blocks directly to the normal body collector; do not add a second full compressed and decoded body representation.

If queue contention is material, evaluate a bounded codec executor separately. [libuv's pool](https://docs.libuv.org/en/v1.x/threadpool.html) is shared across event loops and also services filesystem/DNS work. Merely moving Node zlib calls to `worker_threads` does not create a private libuv pool. A dedicated native pool or process needs explicit capacity limits and must not steal enough CPU to slow browser tests.

## Compatibility boundary

Preserve gzip members, trailers, checksum behavior, empty responses and accepted truncated streams. In particular, today's `Z_SYNC_FLUSH` finish behavior is not interchangeable with a stricter one-shot decoder. Keep encoding recognition, error messages, response completion, cancellation, disposal and trace timing definitions.

Output chunk boundaries are internal here, but backpressure and network abort timing still matter. Do not return the APIResponse before decoding completes. Bound scratch memory and honor deadlines even for extreme expansion ratios. New safety limits that reject previously accepted bodies are a separate API change, not a hidden optimization.

A native adapter must reproduce supported errors or retain the old path for that mode. Restarting decode to obtain the original error is only possible if the exact input has been retained; do not assume a consumed network stream can be replayed. Unsupported CPUs, Node versions or native installations keep existing behavior.

## Payoff and later decision

The target is codec CPU, native/JS dispatch count and decoded-chunk allocation. Large compressed datasets can spend substantial time here; small JSON and uncompressed responses gain little. Bigger buffers increase per-request memory, and more codec threads can lose on saturated hosts.

Later separate buffer-size gains from codec and executor gains. Compare full fetch/decode/dispose time across small/large responses, compression ratios, concurrency and malformed inputs. Include unrelated browser/API operations to detect queue starvation, and measure total CPU/RSS rather than kernel throughput alone.

Run APIRequest compression/error/timeout coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report targeted rows and the full [matrix](../bench/README.md), with current-fork controls under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Defer execution.
