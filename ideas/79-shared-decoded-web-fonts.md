# Share validated web-font data across renderer lifetimes

Scope: visual and navigation suites repeatedly loading large web fonts, especially CJK families, variable fonts and strict contexts. Effort: very large browser work. Potential: avoid repeated font decoding and share large immutable font tables.

**Assessed 2026-10-31:** deferred: browser engine work.

Research, 2026-10-31. Local lifecycle inspection and upstream browser sources only. No font decoding, browser profiling or builds. Upstream main establishes possible integration points; the shipped revision must be checked before implementation.

## Evidence and difference from existing ideas

[`Screenshotter._preparePageForScreenshot`](../packages/playwright-core/src/server/screenshotter.ts) waits for `document.fonts.ready` in the page's frames. Font completion can therefore sit directly on the screenshot critical path. Fresh documents and [context resets](../packages/playwright-core/src/server/browserContext.ts) also create opportunities to repeat font work, although they do not prove that every existing browser cache misses.

Blink's [web-font decoder](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/fonts/web_font_decoder.cc) decompresses/sanitizes font bytes and constructs a typeface. [`FontCustomPlatformData`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/fonts/font_custom_platform_data.cc) accounts for decoded resource memory. Blink already has a substantial [FontCache](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/fonts/font_cache.h); adding an ordinary per-document font cache is not the proposal.

[Idea 36](36-shared-content-addressed-image-decoding.md) shares image pixels and [idea 71](71-share-immutable-stylesheet-parsing.md) shares CSS syntax. Neither shares decoded, validated font tables or removes this decode path.

## Proposed change

Build a browser-owned, bounded store of immutable sanitized font data. After the current response bytes have arrived and passed resource checks, look up an entry by exact encoded content and decoder-policy identity. Reuse validated SFNT tables through read-only shared memory; each document still gets fresh FontFace/load state and each renderer creates the wrappers it needs.

Start with complete ordinary WOFF2 fonts and reuse inside one browser across renderers. Cache successful decode results only. Keep invalid-font diagnostics and unsupported formats on the current path. Do not cache mutable incremental-font-transfer state as if it were a complete font.

The key includes browser/decoder version, sanitization policy and relevant feature settings. Use exact-byte verification where an index could collide. A new URL can reuse identical validated content, but the same URL with changed bytes must miss.

Begin with sharing decoded backing data, not arbitrary SkTypeface pointers, glyph atlases or shaped text. Those have additional process, platform, variation and rendering dependencies. Reuse the browser's existing eviction mechanisms where possible and count shared pages once when measuring physical memory.

## Compatibility boundary

Every document still performs its normal font requests, routing, CORS/CSP checks and load/error events. Cache hits must not mark a font loaded before the current response permits it. Preserve FontFaceSet ordering, font-display behavior, fallback selection, variation axes, shaping and rasterized pixels.

Retain validation policy: a cached successful validation is valid only for identical inputs and policy. Do not skip sanitization by accepting an unverified file merely because a URL was seen before. Keep project/session ownership and bounded cache lifetimes explicit.

Fresh contexts must not inherit another document's FontFace objects, permission decisions or mutable font state. Unsupported browser versions take the ordinary decoder path.

## Payoff and later decision

Savings scale with actual repeat decoding and duplicated tables, not total font traffic. If current renderer/typeface caches already cover the workload, there is no useful gap. Small Latin fonts on warm recycled pages may gain little; large fonts across many renderers offer a larger ceiling.

Later attribute decoding and font-ready latency before building the full service. Compare cold/warm, strict/recycled and multiworker cases, including changed font bytes, failures and variable/color fonts. Require identical geometry and screenshot pixels.

Build on separate capacity and follow the [full matrix and pristine-upstream procedure](01-browser-native-actions.md#payoff-and-decision-test), adding font-heavy rows and same-browser/current-fork controls. Count hashing, service startup, cache misses and eviction; reject memory savings that slow the suite.
