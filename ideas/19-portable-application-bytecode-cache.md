# Reuse application compilation across fresh renderers

**Scope:** strict isolation, many workers, renderer restarts and repeatedly loaded large applications. **Effort:** very large for a generally safe browser integration. **Priority:** high potential where renderer-local warmth is lost.

Research proposal, 2026-10-29. No measurements. This reuses compiled application code, never application heap state, HTTP responses or execution results.

## Evidence and opportunity

The [README](../README.md) explains that context recycling retains the renderer that compiled the application. That benefit does not automatically extend to fresh strict-isolation contexts, other worker browsers or crashed renderers. [`codeCache.ts`](../packages/playwright/src/codeCache.ts) concerns Node framework bundles, a different cache.

[V8's code-caching explanation](https://v8.dev/blog/code-caching-for-devs) distinguishes an isolate-local cache from serialized code caches that can cross processes. The local [Chromium protocol schema](../packages/playwright-core/src/server/chromium/protocol.d.ts) includes `Page.produceCompilationCache`, `compilationCacheProduced` and `addCompilationCache`; it notes heuristic production and that seeded caches do not survive cross-process navigation. These are useful prototype primitives, not a complete persistent-cache design.

## Design

Build a bounded cache of serialized compilation artifacts keyed by exact script bytes, engine/build identity, script kind, origin/compilation context and relevant flags. Share immutable entries across authorized renderers of the same project. Every document still fetches or routes its scripts normally, applies CSP/SRI and executes them from fresh globals. Network events, authentication and server side effects remain intact.

The robust integration point is after the browser has the current source bytes and before compilation. Compute or reuse a verified content digest there, choose a compatible artifact, and let V8 reject incompatible entries and compile normally. Publish artifacts atomically; handle rejected/corrupt entries as cache misses. Keep storage separate from application HTTP cache namespaces so ordinary cache-reset semantics remain correct.

For a narrow feasibility experiment, use known content-versioned fixture scripts with the existing CDP production/seeding commands. Do not deploy URL-only reuse: a URL can return changed or personalized source, and this proposal does not assume V8's internal acceptance checks alone prove exact source identity. General installation across process-swapping navigations likely needs a browser-level hook beyond the page-scoped CDP commands.

Start with classic external scripts. Module graphs, workers, inline scripts, dynamic code and Wasm are later independent extensions, with explicit compatibility keys and unsupported cases compiling normally. Avoid forcing eager compilation of every function just to improve a cache statistic; generation overhead can exceed later savings.

## Compatibility boundary

No cookies, storage, DOM, random values, globals, closures or optimization feedback tied to a prior execution may leak. Preserve source locations, stack traces, debugger/coverage behavior and module identity. Isolate entries by project/security context where needed; a cache must not expose another project's source or artifacts.

Respect `FLASHWRIGHT_ISOLATION=strict`: fresh contexts remain fresh. Persistent compilation reuse can change compilation timing and cache-related metrics; document any newly observable cache behavior and provide a disable switch before release. Unsupported or timing-sensitive instrumentation modes use ordinary compilation.

## Payoff and later validation

The target is repeated parsing/compilation outside the already-warm renderer. Default recycled runs may gain little. Compare against normal Chromium caches and current recycling; count artifact generation, hashing, transfer, decoding, cache eviction and disk/RSS. Cache misses must remain cheap.

Later test same-URL changed bytes, same-length replacements, personalized responses, CSP/SRI, module imports, process swaps, worker restarts and corrupt entries. Compare strict and recycled modes separately. Run `tests/page` on `chromium-page`, navigation/script/security/debugger library coverage and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Add large-script/strict-context rows alongside `node bench/run.mjs todomvc 1 15 stock,fork` and `node bench/matrix.mjs 15`, including an old-fork baseline under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test).
