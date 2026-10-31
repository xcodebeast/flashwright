# Reuse GPU compilation artifacts across isolated worker browsers

Scope: WebGPU/WebGL apps such as editors, maps, 3D viewers and browser ML, especially with several independent browser processes. Effort: very large. Potential: avoid compiling identical shaders and pipelines separately in each worker.

**Assessed 2026-10-31:** deferred: browser work.

Research proposal, 2026-10-31. No GPU workload or browser build run. This is conditional on misses in the caches already present.

## Evidence and distinct opportunity

Flashwright's [worker model](../README.md) normally gives workers separate browsers; warm contexts preserve some work within a browser but do not establish reuse across GPU-process lifetimes. Graphics APIs remain functional, as covered by [capability tests](../tests/library/capabilities.spec.ts) and [WebGL screenshots](../tests/page/page-screenshot.spec.ts).

Dawn already has a [blob-cache implementation](https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/native/BlobCache.cpp). Its [device cache identity](https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/native/Device.cpp) incorporates adapter information, enabled features, toggles and versioning. Browser and driver caches also exist. The proposal is to extend useful cache lifetime and sharing across eligible Flashwright browsers, not to claim shader caching is absent. The external main-branch sources must be reconciled with the exact packaged browser revision before implementation.

[Idea 19](19-portable-application-bytecode-cache.md) reuses JavaScript compilation. [Idea 36](36-shared-content-addressed-image-decoding.md) reuses decoded images and potentially textures. GPU program translation and pipeline compilation are separate costs and artifacts.

## Proposed change

Add a bounded project-owned cache service for immutable GPU compiler artifacts. Integrate at Dawn's existing cache callbacks first. Preserve its full compatibility key and add project/device-driver/build identity wherever the existing boundary requires it. Reuse backend-produced blobs only through that backend's supported load path.

Each test still creates fresh devices, contexts, programs, bindings, buffers and textures. Only compilation results are reusable. Source validation, feature checks, pipeline descriptor validation and application-visible initialization still happen. Never share live driver handles across processes or reuse a previous test's GPU memory.

Begin with WebGPU on one backend and repeated identical pipeline descriptions across independent worker browsers. If this removes real misses, investigate ANGLE program binaries separately. GLSL translation, linked WebGL programs and native WebGPU pipeline blobs have different keys and invalidation rules; one generic source-string hash is insufficient.

Publish entries atomically, verify their integrity, treat rejected blobs as misses and bound disk/RAM usage. Deduplicate simultaneous compilation only when waiting for another worker is faster than local compilation. A dead publisher must not stall a test. Keep existing cache paths as the fallback and support a cold-cache switch.

## Compatibility boundary

Include shader source, entry points, specialization constants, layouts, render-target formats, sample counts, enabled features and backend-required pipeline state in identity. Driver updates, device changes, GPU-process crashes and compiler changes invalidate incompatible artifacts. Do not bypass validation or alter floating-point compilation settings to improve hit rates.

Preserve shader diagnostics, error scopes, promise completion behavior and device-loss handling. Compilation timing is observable; projects testing cold compilation need an explicit disable option. Keep caches private to an authorized project and avoid URL-only identity or shared browser profiles, which would also share unrelated state.

## Payoff and later decision

The strongest case is expensive repeated pipeline creation across workers or fresh browser launches. A warm single-browser suite may already hit existing caches and gain nothing. Disk lookup, hashing and service startup can erase small compilation savings; adding another cache is not useful without demonstrated misses.

Later compare default driver/browser caches, shared artifacts and genuinely cold controls on both software and hardware backends. Check rendered pixels, compute outputs, diagnostics and loss/recovery. Run WebGPU/ANGLE conformance plus upstream page/library/runner coverage against pristine upstream. Report graphics workloads alongside the [full matrix](../bench/README.md), with cache generation, cleanup, CPU and memory included. Build and test on separate capacity.
