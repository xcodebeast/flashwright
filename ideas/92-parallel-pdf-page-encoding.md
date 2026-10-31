# Encode recorded PDF pages concurrently after print layout finishes

Scope: tests generating long or graphics-heavy PDFs through `page.pdf()`. Effort: very large Chromium/Skia work. Potential: shorten PDF generation without parallelizing live DOM execution or changing print layout.

**Assessed 2026-10-31:** deferred: only `page.pdf()`.

Research proposal, 2026-10-31. Source research only; no documents generated or browser builds run.

## Evidence and distinct opportunity

[`CRPDF.generate`](../packages/playwright-core/src/server/chromium/crPdf.ts) waits for `Page.printToPDF`, then reads the returned stream. Faster client transport cannot eliminate the work before that command returns.

Chromium's current [`MetafileSkia::FinishDocument`](https://chromium.googlesource.com/chromium/src/+/main/printing/metafile_skia.cc) holds recorded page content and plays pages into one document in a serial `beginPage`/draw/`endPage` loop before closing it. This exposes a possible boundary between page capture and PDF construction. Confirm the exact headless print path in the packaged revision before implementing; the cited source is Chromium main.

Skia already has machinery for threaded PDF work, including an executor documented for parallel DEFLATE in its [PDF metadata interface](https://chromium.googlesource.com/experimental/external/gob/skia/skia/+/df87c52d7e863998119c0ea1985dbd9aa539f389/include/docs/SkPDFDocument.h). Merely saying “compress on threads” would miss that prior work. The new target is independent page-content translation and resource preparation that remain serial after any existing codec parallelism.

[Idea 04](04-raw-screenshot-comparison.md) handles raster assertions. [Idea 55](55-trace-archive-compressed-splicing.md) assembles trace ZIPs. Neither changes browser PDF generation.

## Proposed change

Keep print-media setup, pagination, headers/footers and page capture on their current lifecycle path. Once a page's paint record and dependencies are immutable, hand it to a bounded encoder that produces a page-local PDF command representation plus references to required resources.

Build a document resource table in stable first-use order. Parallel jobs can prepare immutable resource data, but font-subset ownership, image deduplication and cross-page references must be resolved consistently. Assign final object numbers and assemble the page tree, destinations, outlines and cross-reference table deterministically in the existing page order.

Start with untagged PDFs using supported paint operations. Keep tagged PDFs, unsupported effects and resources requiring thread-affine callbacks on the existing path until those dependencies are covered. Do not call one shared `SkDocument` concurrently or build separate complete PDFs and concatenate them: both bypass essential document-wide state.

Prototype bounded parallel preparation while keeping final serialization serial. If that wins, move more page translation into private worker state. Later pipelining can start after individual records are safe, but must not evaluate DOM, header scripts or mutable resources twice. Limit outstanding pages so a long PDF cannot multiply peak memory by its page count.

## Compatibility boundary

Preserve text/searchability, embedded fonts, images, vector geometry, transparency, links, page ranges, metadata, outlines and accessibility tags. Rendering equivalence alone is insufficient for document tests. Cross-page font subsetting must include every used glyph without changing text extraction.

Preserve object ordering and bytes wherever the current output is stable. If a compatible faster writer necessarily changes PDF serialization, make it an explicit mode with documented byte-level differences and the original writer as opt-out. Never lower image quality, rasterize vector pages or drop tags to claim a speedup.

Wait for every encoding job and final stream before resolving `page.pdf()`. Cancellation, renderer loss and worker failures must free resources and return the established error, not a partial successful PDF.

## Payoff and later decision

Long vector/image-rich documents offer a larger ceiling than one-page receipts. Print layout, font preparation or existing compression workers may already dominate, leaving little page-level work to parallelize. Attribute those phases before investing in the full writer.

Later compare parsed PDF structure, text, links/tags, rasterized pages and stable bytes against the original browser. Include shared fonts/images across many pages and canceled generation. Run print/PDF engine coverage and upstream page/library/runner suites against pristine upstream. Report PDF workloads beside the [full matrix](../bench/README.md), with current-fork controls, all encoding threads and peak memory. Use separate build/test capacity.
