# Reuse decoded images across fresh pages and renderers

**Scope:** image-heavy applications, visual suites and parallel fresh-context runs. **Effort:** very large, requiring browser changes. **Priority:** exploratory, with substantial CPU and memory potential on repeated large assets.

**Assessed 2026-10-31:** deferred: needs a browser build (custom browsers are the last option).

Research proposal, 2026-10-31. No browser build or measurements. This shares derived image data, not [JavaScript bytecode](19-portable-application-bytecode-cache.md), HTTP responses or screenshot comparison results.

## Evidence

Flashwright's [context reset](../packages/playwright-core/src/server/browserContext.ts) creates fresh pages and clears browser caches. That does not prove every decoded image is evicted: Chromium already has substantial caching. Its [compositor documentation](https://chromium.googlesource.com/chromium/src/+/main/docs/how_cc_works.md) describes image decode/scale/color work, and [`GpuImageDecodeCache`](https://chromium.googlesource.com/chromium/src/+/master/cc/tiles/gpu_image_decode_cache.h) retains decoded/uploaded images in discardable memory.

The missing opportunity to investigate is reuse by exact content across document/resource identities and renderer lifetimes, where existing caches miss. Do not add another ordinary image cache or assume default recycled runs always decode again. The strongest target is multiple renderers repeatedly loading the same large fixtures.

## Proposed change

Add a browser-owned store of immutable decoded raster images, addressed by verified encoded content and the complete decode configuration. Lookup happens only after the current request has delivered and validated its bytes. Each document still performs its own request, routing, authentication, redirects and normal resource lifecycle.

Begin with complete, nonanimated PNG/JPEG images and CPU pixel surfaces. Key entries by content, decoder/build identity, dimensions, orientation, color profile, alpha representation and decode scale. Share read-only pixel memory among eligible renderers. Keep request objects, canvas origin-clean state and document ownership private. Identical bytes do not imply identical origin permissions.

Use Chromium's existing discardable-memory mechanisms with a run-wide byte budget. Deduplicate simultaneous decodes only when the shared job's scheduling does not delay a more urgent request. Eviction falls back to normal decode. A later GPU tier can share compatible uploaded textures within a GPU device/context lifetime; it must handle device loss and cannot reuse arbitrary texture handles across browsers.

## Compatibility

Do not bypass HTTP cache policy, service workers, request listeners or network failures. Preserve `decode()`, load/error events, dimensions, pixel colors, canvas tainting and screenshot output. Reuse computation only once the same resource prerequisites are satisfied; do not complete a progressive image early because a prior test already downloaded it.

SVG, animation, partial responses, video and unsupported color/decoder modes initially use the original path. In particular, SVG output can depend on external resources and document state. Maintain context boundaries for sensitive content; cross-project/global sharing is unnecessary.

Introduce a revision-negotiated browser option with an ordinary-browser fallback. Document altered cache-related timing or memory observations if exposed. This keeps all requested images and browser capabilities, unlike resource blocking or [capability exclusions](31-per-test-browser-capability-contracts.md).

## Payoff and later decision

The target is repeated decode, scaling and possibly upload work, plus duplicate pixel storage. Network transfer remains. Content hashing, shared-memory coordination and larger retained caches can lose on small images or low reuse.

First establish actual cross-page/cross-renderer misses using future decoder counters. Then prototype CPU sharing for one raster format and compare pixels and lifecycle events, including changed bytes at the same URL, different origins, cancellation and eviction. Reject it if the existing cache already captures the available reuse.

Later build elsewhere and run image/canvas/network/screenshot coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report asset-heavy strict/recycled rows beside the full `node bench/matrix.mjs` and scenario command, including current-fork/ordinary-browser controls. Follow the [shared rules](01-browser-native-actions.md#payoff-and-decision-test); count CPU, GPU and shared memory once, and include cache preparation and disposal.
