# Reuse HTML tokens from speculative scanning during document parsing

Scope: large server-rendered pages, streamed HTML and repeated full-document navigation. Effort: monumental browser-parser work. Potential: remove duplicated tokenization and move eligible work off the renderer's critical thread.

**Assessed 2026-10-31:** deferred: browser parser work.

Research, 2026-10-31. Primary-source investigation only; no parser build, page loads or measurements. This is a hypothesis about eligible parser paths, not a claim that HTML parsing dominates the current benchmark apps.

## Evidence and difference from existing ideas

Blink's [HTMLDocumentParser](https://chromium.googlesource.com/chromium/src/third_party/+/refs/heads/main/blink/renderer/core/html/parser/html_document_parser.h) owns its tokenizer and tree builder. Its [HTMLPreloadScanner](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/html/parser/html_preload_scanner.cc) owns another tokenizer, scans input for preloads and clears each token after consuming it. Eligible paths can scan input speculatively and then tokenize it again for DOM construction.

Background scanning and script precompilation already exist. The proposed gain is retaining useful tokenization from that work, not merely turning on a background scanner.

This does not restore a previous DOM, pre-execute application scripts or change `preloadPages`. [Idea 19](19-portable-application-bytecode-cache.md) reuses JavaScript compilation, and [idea 71](71-share-immutable-stylesheet-parsing.md) reuses CSS parsing; this removes duplicate work within one HTML load.

## Proposed change

Let eligible speculative scans produce compact, immutable token batches with source offsets and tokenizer-state checkpoints. The ordinary main-thread parser consumes a batch only when its input position and required tokenizer state match. The existing tree builder still creates fresh DOM nodes in order and owns script execution and parser pauses.

Start with stretches of ordinary HTML where scanner and parser states are known to agree. Keep token data in bounded arenas and transfer ownership across threads. Avoid copying complete source strings into every token; retain source segments only while a queued token references them.

When the main parser is ahead or no matching batch exists, use its current tokenizer immediately. Never wait for speculative work solely to increase reuse. Once the main parser consumes a region, cancel or skip redundant scanning where doing so preserves preload behavior.

Track input generations. `document.write`, encoding changes and parser reentry can invalidate queued tokens. Discard only unconsumed speculative data and resume ordinary tokenization from the correct saved position. Never rebuild already-published DOM or rerun a script to recover from a bad prediction.

## Compatibility boundary

The [HTML parsing model](https://html.spec.whatwg.org/multipage/parsing.html) couples tokenization and tree construction. Script data, foreign content, malformed markup and custom-element reactions make this more than a generic producer/consumer queue. A checkpoint must capture all state affecting token interpretation, not just a byte offset.

Keep DOM mutation order, parser-blocking scripts/styles, microtask checkpoints, document.write insertion, charset handling, EOF behavior and source positions. Preserve the current speculative request policy and CSP/base-URL handling; retaining tokens is not permission to issue extra requests or execute script early.

Use the old path whenever state agreement is uncertain. Begin with the network-document parser; fragment parsing and `setContent` can remain unchanged. Apply the same semantic checks on cache-hit and fallback paths.

## Payoff and later decision

The ceiling is duplicated tokenizer CPU plus eligible main-thread tokenization moved off the critical path. Tree building, layout, script execution and network time remain. Small app shells and saturated parallel runs may lose to queueing, token retention or extra synchronization.

Later first count how much input the pinned browser tokenizes twice. Then compare full navigation through large static and streamed HTML, with adversarial parser scripts and malformed documents. Check ordered DOM/script/request observations, not just the final DOM.

Build and run parser/web-platform tests on separate capacity, then use the [full Flashwright matrix and upstream regression procedure](01-browser-native-actions.md#payoff-and-decision-test), adding HTML-heavy cases and same-build/current-fork controls. Account for all helper-thread CPU and queued-token memory. No experiments here.
