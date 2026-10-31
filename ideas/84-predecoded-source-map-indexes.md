# Decode source maps once and share the lookup representation

Scope: large TypeScript suites, generated tests, large helper bundles and many worker processes. Effort: large. Potential: remove repeated source-map decoding and object allocation during collection and worker startup.

**Assessed 2026-10-31:** partly done (`2c03932a`): the parsed maps were sorted twice per file, by generated and by original position. Mappings already in order now stay as they are, and the original order is sorted only when a lookup needs it, which mapping stack frames never does. Listing tests/page (2626 tests, 136 files): 705 -> 610 ms, every location unchanged. Decoding the mappings still takes about 30 ms there; a pre-decoded index would need its own exactness proof against source-map's lookups.

Research proposal, 2026-10-31. Read-only investigation; no new measurements.

## Evidence and distinct opportunity

[`compilationCache.ts`](../packages/playwright/src/transform/compilationCache.ts) already caches transformed code and JSON maps. Its source-map callback still reads and parses a map when a process first needs it. The installed `source-map-support` caches a `SourceMapConsumer` within that process. The pinned `source-map` consumer lazily decodes mappings into JavaScript objects and sorts generated/original mapping arrays. These costs are not paid on every frame, but they recur in separate processes.

[`wrapFunctionWithLocation`](../packages/playwright/src/transform/transform.ts) also maps test declaration locations. A file can therefore incur map preparation before its test body runs. The current mapped-frame cache helps repeated positions after preparation; it does not share prepared maps between collection, workers and later invocations.

[Idea 12](12-native-test-transformation.md) changes compilation. [Idea 66](66-structured-callsite-pipeline.md) removes stack formatting/parsing and caches mapped positions. This proposal changes the stored mapping representation, independently of either.

## Proposed change

Publish an optional decoded lookup sidecar beside each content-addressed transform entry. Store generated line boundaries, columns, source/name indexes and original positions in packed arrays. Keep source strings in a separate table. Build only the generated-to-original index needed for stack/declaration lookups; retain the ordinary map for other consumers.

Generate the sidecar once, either during transformation or on the first actual mapping request. Choose the latter for files whose maps are rarely used. Publish atomically and key by exact map content, decoder version and representation version. A missing, corrupt or incompatible sidecar falls back to the installed consumer.

Start with a JavaScript adapter reading a bounded binary Buffer. A native read-only memory mapping is a later option if sharing pages between workers saves enough memory to justify an addon. Loading a binary file into separate Buffers avoids decoding but does **not** itself share physical memory; report those stages separately.

Keep existing CallSite capture, formatting, naming rules and final frame cache. Adapt only the position lookup. Resolve source URLs against the requesting module's URL, or include that base in the cache identity. Identical relative map bytes in different directories need not refer to the same source files.

## Compatibility boundary

Preserve the pinned consumer's lookup bias, duplicate-position tie breaking, unmapped segments, names, line/column conventions, indexed-map sections and missing-map behavior. The [source-map specification](https://tc39.es/ecma426/) defines VLQ mappings and indexed maps, but the installed consumer remains the compatibility reference for existing projects.

Keep unsupported extensions on the current path. Preserve `sourcesContent`, error snippets and debugger consumers rather than stripping the original map to save space. Bound resident mappings and close mapped files safely on Windows. Concurrent writers and cache deletion must behave as cache misses, never partial results or startup failures.

## Payoff and later decision

For a reused map, the target changes from decoding/sorting once per process to decoding once plus cheap indexed reads. Large maps and many workers offer the strongest CPU and memory opportunity. Small suites or cold maps used once may lose because sidecar creation adds work.

Later compare first-run and warm-run totals, collection, worker restarts and source-map-heavy failures. Differentially compare locations, complete stacks and snippets, including maps with duplicate columns and section offsets. Run `tests/playwright-test` and the normal browser regression bar against pristine upstream. Report the [full matrix](../bench/README.md) with current-fork controls, plus large-map cases, sidecar creation time, disk use and peak memory. No compilation or profiling on the busy machine.
