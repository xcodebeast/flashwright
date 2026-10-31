# Read back only screenshot regions whose pixels could have changed

Scope: repeated high-resolution visual assertions and screenshots of mostly unchanged pages. Effort: very large, including compositor integration. Compatibility: identical captured pixels and assertion decisions.

**Assessed 2026-10-31:** deferred: compositor work. A capture is bound to the frame: 16.7 ms for PNG and JPEG alike on a 1280x720 page; `aafd2f99` already moved the baseline decode into that wait.

Research, 2026-10-31, against `1f613889` and public Chromium sources. No captures or timing runs.

## Evidence and distinction

[`Page.expectScreenshot`](../packages/playwright-core/src/server/page.ts) takes repeated captures when establishing stability or handling a mismatch. [`CRPage.takeScreenshot`](../packages/playwright-core/src/server/chromium/crPage.ts) requests a complete clipped image through `Page.captureScreenshot`. The fork already optimizes PNG encoding and avoids repeated image decoding within an assertion.

Chromium's [`DamageTracker`](https://raw.githubusercontent.com/chromium/chromium/main/cc/trees/damage_tracker.h) identifies changed render-surface regions to reduce drawing. That information could also reduce automation readback, but ordinary display damage is not automatically a complete screenshot-validity guarantee.

[Idea 04](04-raw-screenshot-comparison.md) removes encode/decode work around a full pixel capture. This proposal removes repeated readback and comparison of unchanged pixels. [Idea 89](89-demand-driven-headless-frames.md) changes frame scheduling; the capture schedule stays unchanged here.

## Design

Keep a bounded prior raw surface for an active screenshot session, identified by document, capture geometry, device scale, color configuration and screenshot preparation options. At every existing capture boundary, perform the normal lifecycle updates and obtain a compositor completion fence plus conservative damage since the prior capture.

If all contributing surfaces prove unchanged, reuse the prior pixels after that fence. Otherwise copy damaged rectangles or tiles and reconstruct the exact current image from old and new pixels. Start with viewport captures without overlays, video or out-of-process frames; unsupported surfaces trigger full readback.

For assertions, retain per-region comparison results only when the baseline, comparator and options match. Recompute affected regions and any neighboring pixels used by antialias detection. A first implementation can still compare the whole reconstructed image, isolating readback savings from incremental comparison.

## Functional boundary

Keep font readiness, animation treatment, caret hiding, masks, style injection, scrolling, screenshot queues and restoration. These operations can themselves cause damage. Changing clip, scale or full-page geometry invalidates incompatible retained surfaces.

GPU canvases, compositor animations, child surfaces, filters, blending, scroll exposure and device loss require complete invalidation coverage. A quiet DOM or unchanged frame ID is insufficient. A pixel hash may index a candidate but cannot establish equality by itself. Fall back whenever the damage history or fence is uncertain.

Keep the existing stability waits and number of observation boundaries. Reusing pixels after proving a later capture identical must not resolve the assertion before that later capture would occur. Public screenshots and failure attachments still encode complete images with their existing behavior.

## Payoff and later decision

For an image of `P` pixels with `D` damaged pixels, the target is readback near `D` plus bookkeeping instead of `P`, after the first capture. Full-screen changes offer no advantage; retaining prior pixels costs roughly one uncompressed image per session.

Later compare full and partial capture pixel-for-pixel on moving canvases, frames, masks, filters, scrolling and failures. Measure GPU synchronization, copied bytes, total RSS and end-to-end assertion time. Run screenshot/comparator regressions, `tests/page` on `chromium-page` and runner snapshot tests against pristine upstream, then the [whole matrix and current-fork controls](01-browser-native-actions.md#payoff-and-decision-test). No speedup counts if it misses a changed pixel.
