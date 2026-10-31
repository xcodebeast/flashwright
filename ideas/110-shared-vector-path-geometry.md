# Reuse vector path geometry across fresh browser workers

Scope: large SVG maps, diagrams, CAD views and Canvas Path2D applications. Effort: very large Blink/Skia work. Potential: save repeated path preparation and tessellation after ordinary caches lose useful identity or lifetime.

Research, 2026-10-31, against local capture paths and current Blink/Skia sources. No graphics workloads or GPU probes run. The selected rendering backend and exact packaged revision must be established before implementation.

## Evidence and distinction

Blink already keeps a weak parsed-path cache in [`SVGPath`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/svg/svg_path.cc). Skia's [`TriangulatingPathRenderer`](https://raw.githubusercontent.com/google/skia/main/src/gpu/ganesh/ops/TriangulatingPathRenderer.cpp) also caches vertex data, checks tolerance compatibility and ties invalidation to path changes. Simply caching SVG parsing or enabling existing tessellation caches would not be new.

Those caches do not by themselves establish reuse across independent browser processes. The opportunity is a second-level immutable geometry store where fresh path identities or graphics-process lifetimes cause real misses. [Idea 36](36-shared-content-addressed-image-decoding.md) deliberately excludes SVG from its initial raster-image design. [Idea 90](90-shared-gpu-pipeline-artifacts.md) caches shader programs, which do not contain a particular map's triangles.

Playwright still waits for real rendering in [`Screenshotter`](../packages/playwright-core/src/server/screenshotter.ts). Faster capture encoding cannot eliminate vector preparation needed to produce those pixels.

## Proposed change

Integrate first with one existing CPU geometry-generation path. Address an immutable result by exact path commands plus the full parameters that determine its output. Store portable vertex/index data or another backend-approved geometry representation; keep live GPU buffers private to their device/context.

On a hit, bind the shared CPU geometry to the current graphics context and perform ordinary painting. Every document still parses its current SVG/Canvas commands, resolves styles and resources, and applies its own transforms, clipping and compositing. Cache only after those inputs establish an equivalent geometry job.

Key by fill rule, stroke/dash parameters, transformation and precision requirements, anti-aliasing mode, clipping inputs when relevant, algorithm/build identity and backend constraints. A path string alone is not sufficient. Start with exact parameter matches and unchanged tessellation tolerances. Do not substitute a coarser mesh merely because the screenshot looks similar.

Give paths a verified content identity once, with generation invalidation on mutation, rather than hashing thousands of coordinates on every draw. Bound shared storage by bytes and bypass it for cheap, unique or rapidly morphing paths. Cross-process publication must be atomic, with ordinary local generation on misses or rejected entries.

The GPU tessellation path and CPU triangulation path are different. Skia's [`TessellationPathRenderer`](https://raw.githubusercontent.com/google/skia/main/src/gpu/ganesh/ops/TessellationPathRenderer.cpp) chooses among strategies; do not force an otherwise slower strategy just to make caching possible.

## Functional boundary

Preserve pixels, geometry precision, winding, clipping, hit testing, animation and path mutations. Leave SVG DOM, styles, filters, external resources and origin rules private. A reusable geometry object is not a reusable rendered SVG image.

Handle graphics resets and eviction without dangling resources. Fall back on unsupported transforms or rendering modes. Keep the same graphics backend and browser settings in performance comparisons; changing them can alter both output and speed.

## Payoff and later decision

Complex repeated paths across worker browsers are the plausible win. Warm paths already covered by Skia's cache, tiny icons and GPU-bound fragment shading offer little opportunity. Read-only geometry sharing may reduce CPU memory, but upload costs and GPU memory can remain.

Later establish actual cache misses and selected path renderers before building a shared store. Compare pixels and interaction on repeated/unique paths, zooms, strokes, clipping and context loss. Run Skia/SVG conformance and the [full matrix/upstream procedure](01-browser-native-actions.md#payoff-and-decision-test), with vector-heavy additions and cache construction/remapping costs included. Use separate build capacity.

**Assessed 2026-10-31:** deferred: browser-internal (Blink/Skia), needs a custom Chromium; raster and composite are ~9% of CPU and off the w1 critical path in the measured suites.
