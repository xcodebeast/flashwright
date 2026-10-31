# Reuse module binding plans while creating fresh module state

Scope: applications with large ES-module graphs, barrel exports and repeated fresh-document startup. Effort: very large V8/Blink integration. Potential: avoid repeated graph analysis and export resolution after source compilation.

Research, 2026-10-31, against `913231d4` and public Chromium/V8 main sources. No modules loaded or browser built. Match external implementation details to the [packaged browser](../packages/playwright-core/browsers.json) before development.

## Evidence and distinction

Blink's [`ModuleTreeLinker`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/loader/modulescript/module_tree_linker.cc) fetches module dependencies and instantiates the resulting graph. V8's [`SourceTextModule`](https://raw.githubusercontent.com/v8/v8/main/src/objects/source-text-module.cc) resolves exports, detects cycles and connects import/export cells. It already caches resolved exports on the current module object; this proposal must improve reuse across fresh graphs, not duplicate that cache.

[Idea 19](19-portable-application-bytecode-cache.md) preserves parsing/compilation artifacts. Reusing bytecode still requires fresh module environments and correct live bindings. [Idea 50](50-indexed-module-resolution.md) accelerates Node's file/module lookup. This proposal concerns the browser's binding graph after the current dependencies have been resolved.

The [fresh-page lifecycle](../packages/playwright-core/src/server/browserContext.ts) creates opportunities for repeated module instantiation even when source and bytecode are warm. That establishes a possible reuse boundary, not a measured bottleneck.

## Proposed change

Record a successful linkage as an immutable recipe. Identify graph nodes by verified source and compilation mode, record the current resolved dependency edges, and encode which export slot supplies each import. Include namespace export layouts and strongly connected components where supported.

On another identical graph, allocate fresh module objects, environments and binding cells. Apply the recipe to connect those new cells, then enter the engine's normal evaluation machinery. No initialized values, namespace objects, promises, closures or mutable cells survive from the earlier execution.

Verify graph identity using the current loader's results. Include import attributes, module kinds, resolved URLs and import-map/base-URL context where they affect resolution. Identical text does not imply identical dependencies. Cache lookup cannot skip a host resolution callback or a fetch merely because a prior graph had the expected edge.

Start with successful static JavaScript graphs and direct named imports/exports. Add re-export chains and cycles only with complete validation of ambiguity and component ordering. Unsupported JSON/CSS/Wasm modules, dynamic graph changes, instrumentation modes and cache misses use ordinary linking. Failed graphs retain the existing error path initially.

Store pointer-free slot descriptions, not V8 heap addresses. Bound the cache and use it only above a graph-size/reuse threshold. Within-renderer reuse is a smaller first step than cross-browser persistence.

## Functional boundary

Every document still makes its normal requests, applies CSP/SRI/MIME rules and executes modules once under that document's module map. Preserve live bindings, temporal dead zones, namespace identity and property order, evaluation side effects, import errors and source locations.

Top-level await requires fresh async dependencies and promises with the ordinary completion order. Do not replay a prior evaluation order as if it captured current asynchronous behavior. Module fetching, linking and execution are different phases; accelerating one does not authorize moving the others earlier.

## Payoff and later decision

The removable work is repeated resolution and graph bookkeeping; allocation of fresh state remains. Large unbundled graphs or heavy re-export structures are the plausible targets. Bundled apps with a few modules, and runs dominated by fetch or evaluation, may gain little.

Later isolate link time with bytecode already warm, then test changed import maps, same-source/different dependencies, cycles, ambiguous exports and top-level-await failures. Require identical execution logs and live-binding behavior. Run engine module tests, navigation/worker tests and the [full matrix/upstream procedure](01-browser-native-actions.md#payoff-and-decision-test), including cache production and verification costs. Reject a cache whose graph verification costs as much as ordinary linking.

**Assessed 2026-10-31:** deferred: browser-internal (V8/Blink module loader), needs a custom Chromium. The measured per-test app load (TodoMVC ~8-10 ms per load, already a V8 code-cache hit) leaves little for linkage alone.
