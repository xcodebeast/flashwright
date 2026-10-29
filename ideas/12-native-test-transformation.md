# Replace repeated Babel work with a compatible native transform path

**Scope:** cold CI, large TypeScript suites and worker-only dynamic imports. **Effort:** large. **Priority:** high if transformation is a material startup cost.

Research proposal, 2026-10-29; no new measurements. This concerns user-module transformation, not the [framework heap snapshot](09-preinitialized-node-runtime.md) or the existing framework V8 cache.

## Evidence and opportunity

[`transformHook`](../packages/playwright/src/transform/transform.ts) hashes source/configuration, looks in the compilation cache, then invokes Babel on a miss. [`babelBundle.ts`](../packages/playwright/src/transform/babelBundle.ts) applies a substantial pipeline: TypeScript, JSX, module conversion, decorators, class features and version-dependent resource-management support.

[`compilationCache.ts`](../packages/playwright/src/transform/compilationCache.ts) explicitly prevents workers from writing persistent entries. Consequently, worker-only dynamic imports can be transformed separately in multiple workers. Static imports usually benefit from the loader's existing disk cache. The opportunity is faster misses and shared immutable results, not inventing a cache that already exists.

## Design

Introduce a transform adapter with a native compiler for a proven subset, retaining Babel for unsupported syntax, custom preprocessors and plugins. [SWC documents TypeScript, JSX and transform configuration](https://swc.rs/docs/configuration/compilation); those primitives make it a candidate, not a compatibility guarantee. Compare a narrowly configured SWC path with a dedicated native pass if its semantics do not match.

Use the same resolution rules and module boundaries. Compile individual modules rather than bundling user code, which could change evaluation order, circular imports, dynamic imports and module identity. Publish immutable code/map pairs atomically with a manifest keyed by complete source, resolved configuration, compiler version, Node target, module mode and relevant plugin inputs.

Allow workers to publish safe cache misses. Coordinate duplicate work per key where coordination is cheaper than compilation; a worker should not wait indefinitely for a dead writer. Readers accept only complete verified entries. Custom plugins with untracked external inputs stay on the current path or require explicit cacheability metadata. Do not speculatively import user modules to warm the cache.

## Compatibility boundary

Match execution semantics and source positions, not emitted text. Decorator version, class field definition versus assignment, TS namespaces/enums, import attributes, `export =`, JSX factory/runtime, CJS interop and resource disposal are concrete hazards visible in today's pipeline. Unsupported cases must fall back **before module execution**; retrying with Babel after a partially executed module is unsafe.

Preserve test declaration locations, stack traces, coverage/debugging behavior and import errors. Keep Babel usable on platforms without the native binary. A native startup cost paid for a tiny cache hit would defeat the purpose, so load the alternate compiler only on eligible misses.

## Payoff and later validation

The ceiling is uncached transform time plus duplicated dynamic-import compilation. Fully warm small suites may see no improvement. Count binary load time, cache coordination, map generation, cache writes and disk footprint; do not count a warm candidate against cold Babel.

First implement atomic worker publication with the existing Babel output, then independently compare the native subset. This distinguishes savings from deduplication and compiler speed. Use cold/warm caches, shared dynamic helpers, source/config edits and concurrent invocations; compare behavior against the existing transformer.

Later run `tests/playwright-test` including `babel.spec.ts`, ESM, tsconfig, source-map and component-transform consumers; run `tests/page` on `chromium-page` against pristine upstream in `workbench/pw-src`. Add a large-module corpus alongside `node bench/matrix.mjs 15` and `node bench/run.mjs todomvc 1 15 stock,fork`, with an old-fork baseline. Apply the [shared evaluation rules](01-browser-native-actions.md#payoff-and-decision-test). Defer compilation and benchmarking until the machine is available.
