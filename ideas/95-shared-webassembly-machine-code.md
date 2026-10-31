# Reuse compiled WebAssembly across isolated browser workers

Scope: browser IDEs, document editors, CAD, media tools and other applications with substantial Wasm modules. Effort: very large. Compatibility: fresh instances and normal resource loading remain mandatory.

**Assessed 2026-10-31:** deferred: browser work, only applications with large WebAssembly modules.

Research, 2026-10-31, against `1f613889` and public engine sources. No compilation or benchmark runs.

## Evidence and distinction

V8 already performs streaming compilation, tiering and code caching. Its [compilation-pipeline documentation](https://v8.dev/docs/wasm-compilation-pipeline) explains that cached optimized code is associated with streamed modules; baseline compilation and cache thresholds still matter. The earlier [Wasm cache design](https://v8.dev/blog/wasm-code-caching) also describes URL/resource-cache identity. These mechanisms must be audited in the exact packaged browser before claiming a miss.

Flashwright's [context lifecycle](../packages/playwright-core/src/server/browserContext.ts) and [Chromium cache clearing](../packages/playwright-core/src/server/chromium/crNetworkManager.ts) deliberately reset application state. Separate worker browsers cannot assume one another's compiler caches are warm. The opportunity is reuse across those boundaries where existing caches demonstrably miss.

[Idea 19](19-portable-application-bytecode-cache.md) targets JavaScript bytecode. Wasm has different executable-code serialization, tiering, imports and memory ownership. [Idea 90](90-shared-gpu-pipeline-artifacts.md) caches GPU programs. Neither supplies a Wasm module-code service.

## Design

Add a bounded store of validated compiled Wasm modules, keyed by exact module bytes, engine/build, CPU features, compilation options and execution policy. First share serialized optimized artifacts between compatible worker browsers. Later investigate mapping immutable executable code once where V8's relocation and code-pointer model permits it.

Every page still makes its normal request and passes MIME, CSP and other resource checks. Attach cached code only after the current bytes establish the correct module identity. Create a new Module wrapper and instantiate with that call's imports, fresh memories, tables and globals. Execute the start function on every instantiation.

Support byte-buffer compilation as a separate entry point; this is useful for loaders that cannot use the browser's existing streaming cache. Do not hold a streaming miss until the full body arrives just to search the new cache. Preserve ordinary streaming compilation in parallel with lookup when it wins, with bounded duplicate work.

## Functional boundary

Never share instances, mutable memories, imported objects or exported function wrappers between tests. Preserve validation errors, traps, import lookup order, start-function side effects and synchronous versus asynchronous API behavior. Debugging and coverage modes need compatible code or an ordinary compilation fallback.

Treat rejected, corrupt or incompatible artifacts as misses before application execution. Keep origin/project authorization separate from byte equality. A code cache must not skip fetches or make an otherwise forbidden module executable. Bound executable memory and disk storage; do not force expensive tier-up just to manufacture cache entries.

## Payoff and later decision

The removable work is repeated validation/compilation that survives existing engine reuse. Wasm execution and application initialization remain. Large modules restarted in fresh workers offer the strongest ceiling; baseline compilation can already be too cheap to justify loading an artifact.

Later compare cold and warm runs, streaming and buffered APIs, changing URLs, changed bytes and many workers. Include cache production, verification, deserialization and cleanup. Add a Wasm application corpus beside the [full benchmark matrix](01-browser-native-actions.md#payoff-and-decision-test); run engine Wasm conformance tests, `tests/page` on `chromium-page` and runner regressions against pristine upstream. Report current-fork comparisons and CPU/memory, not compiler throughput alone.
