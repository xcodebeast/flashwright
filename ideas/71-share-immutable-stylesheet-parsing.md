# Reuse stylesheet syntax across fresh resource and renderer lifetimes

Scope: applications with large CSS bundles or import graphs loaded repeatedly across tests. Effort: very large browser-engine work. Priority: exploratory, conditional on misses in the browser's existing caches.

**Assessed 2026-10-31:** deferred: browser engine work.

Research, 2026-10-31, against `2bc2768b` plus the live worktree and upstream browser source. No browser build, profile or cache experiment.

## Evidence and opportunity

Flashwright's [`context reset`](../packages/playwright-core/src/server/browserContext.ts) retains useful renderer warmth while clearing caches through browser delegates. This alone does not prove that stylesheet parsing repeats or dominates; actual cache misses need later attribution.

Blink already shares parsed sheets. Its current [`StyleSheetContents`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/css/style_sheet_contents.cc) has resource-cache eligibility and copy-on-write machinery. The inspected implementation excludes sheets with import rules, owner import rules, mutation or load errors from that resource-cache path. These are concrete boundaries to investigate, not evidence that all CSS is reparsed. The pinned browser revision must be checked before implementation.

[Idea 49](49-parallel-browser-style-resolution.md) parallelizes matching and computed-style construction. This proposal reuses earlier syntax parsing; every document still computes its own styles and layout. It also differs from application JavaScript bytecode and decoded-image caches.

## Proposed change

Separate immutable stylesheet syntax from document ownership, load state and computed results. Store a compact immutable parse representation addressed by verified current bytes and parser-context identity. After an ordinary resource load has passed its checks, bind that representation to a fresh document-owned stylesheet instead of parsing the same syntax again.

Start within one renderer and with an eligible external-sheet subset. Keep this derived cache separate from HTTP response caching so required requests still occur after reset. Extend to browser-owned shared read-only backing only if renderer-local retention misses enough reuse to justify a portable representation.

Treat imported sheets as independent verified resources with a fresh per-document dependency graph. Reuse syntax after each current response arrives; do not reuse an earlier graph's completion, failures, redirects or import side effects. Mutable CSSOM wrappers get private overlays or normal copies. Existing lazy parsing must remain lazy where eager materialization would cost more.

## Compatibility boundary

The key must cover relevant encoding, parser mode, base-URL resolution, supported feature configuration and browser build. Keep origin-clean state, CSP/MIME checks, imports, subresource discovery and document ownership private. Identical CSS bytes from different URLs cannot blindly share already-resolved relative URLs.

Preserve cssRules behavior, insertRule/deleteRule, replace/replaceSync, adopted sheets, load/error events, rule order, source positions, computed styles and screenshot pixels. Do not cache font loads, media/container-query results or element styles as if they were immutable syntax. Unsupported constructs take the normal parser before any effects occur.

Use bounded memory and ordinary parse fallback on misses or eviction. Negotiate custom-browser support and retain the standard browser path. Document any newly exposed cache timing behavior; strict context state must remain fresh.

## Payoff and later decision

The ceiling is repeated CSS parsing and associated allocation that existing caches fail to reuse. Rule matching, layout, network and application JavaScript remain. Content checks, binding and copy-on-write can erase the gain; short/simple sheets likely do not justify it.

Later first identify actual parse misses on held-out large stylesheets and import-heavy apps. Compare with the same browser's ordinary caches, then verify CSSOM, loads, pixels and mutation isolation. Build elsewhere; run relevant CSS/web-platform tests and upstream page/runner suites against pristine upstream. Report current-fork/same-build controls, targeted workloads and the full [matrix](../bench/README.md) under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No work that loads the busy machine.
