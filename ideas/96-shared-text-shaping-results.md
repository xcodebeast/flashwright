# Reuse shaped text across fresh pages and renderers

Scope: repeated canvas dashboards, spreadsheets, editors and multilingual text-heavy pages. Effort: very large. Compatibility: exact glyph selection, geometry and pixels.

**Assessed 2026-10-31:** deferred: browser engine work.

Research, 2026-10-31, against `1f613889` and Chromium main. No rendering workloads run; engine details require revision matching.

## Evidence and distinction

Text shaping turns characters and font settings into glyphs, advances and clusters. Blink's [HarfBuzz integration](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/fonts/shaping/harfbuzz_shaper.cc) performs this work. It is separate from downloading and decoding a font.

Existing caches are substantial. [`PlainTextPainter`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/fonts/plain_text_painter.cc) caches canvas text using a `FontFallbackList` identity, while [`FrameShapeCache`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/fonts/shaping/frame_shape_cache.cc) retains nodes/results with bounded eviction. HarfBuzz also [caches shaping plans](https://harfbuzz.github.io/shaping-plans-and-caching.html). The proposal extends reuse across fresh ownership and renderer lifetimes; it does not add the first shaping cache.

[Idea 79](79-shared-decoded-web-fonts.md) saves font sanitization/decompression. [Idea 91](91-parallel-browser-layout.md) distributes layout work. This proposal saves repeated character-to-glyph computation, beginning with canvas text where the cache boundary is explicit.

## Design

Introduce a second-level cache of immutable shaping results after the current document resolves its font and fallback choices. Store compact glyph IDs, advances, offsets, cluster mapping and relevant bounds without DOM pointers or mutable font wrappers. Rebind results to the current renderer's validated font objects.

Key by exact text and context required by shaping: resolved font content, face index, variation axes, size, direction, script/language, feature ranges, shaping flags and engine version. Include surrounding text where contextual shaping depends on it. Font-family names alone are insufficient.

Start with repeated complete canvas runs and a renderer-local cache that survives page disposal. Extend to shared read-only storage only if separate renderers account for enough misses. Batch lookup for substantial runs; an IPC request per short label could cost more than shaping it. Keep existing first-level caches and their cheap hits.

## Functional boundary

Perform document-local font loading and fallback selection on every use. A pending font must not become visible early because another test has decoded or shaped it. Preserve font-display behavior, loading events and later fallback invalidation.

Do not split Arabic, Indic, emoji or ligature-bearing runs at arbitrary word boundaries. Match fractional metrics, variable-font behavior, bidi clusters, selection geometry and canvas text metrics. Keep rasterization and layout private. Unsupported context dependencies take the current path. Bound the shared cache by bytes, including text keys, and release mapped entries safely under memory pressure.

## Payoff and later decision

The target is many repeated labels or paragraphs whose existing caches disappear or miss between tests. Savings stop at shaping; paint, layout and font loading still happen. Small Latin labels may be too cheap, and retaining unique text can increase memory without speeding anything up.

Later test repeated and unique text, font swaps, multiple scripts, variable fonts and canvas/OffscreenCanvas. Compare metrics, hit testing and screenshot pixels before timing complete suites. Use Blink shaping tests plus `tests/page` on `chromium-page`, relevant runner tests and the [full matrix/current-fork comparison](01-browser-native-actions.md#payoff-and-decision-test) against pristine upstream. Count cache lookup, remapping and all renderer memory.
