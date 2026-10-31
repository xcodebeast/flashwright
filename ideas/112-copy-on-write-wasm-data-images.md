# Initialize fresh Wasm memories from copy-on-write data images

Scope: repeatedly instantiated Wasm applications with large static data segments, such as document engines and language tools. Effort: very large V8/platform integration. Potential: avoid copying the same initial memory bytes for each instance.

Research, 2026-10-31, against local context lifetimes and current V8/Wasmtime sources. No Wasm modules instantiated or mappings created. Public main-branch findings need verification against the packaged browser revision.

## Evidence and distinction

V8's [`InstanceBuilder::LoadDataSegments`](https://raw.githubusercontent.com/v8/v8/main/src/wasm/module-instantiate.cc) evaluates active segment offsets, checks bounds and copies bytes into linear memory. This is separate from compiling Wasm instructions. [Wasmtime documents copy-on-write heap images](https://docs.wasmtime.dev/examples-fast-instantiation.html) as an implemented way to defer these copies until memory is written. That is evidence of feasibility in another runtime, not a claim that it can be enabled in Chromium with a flag.

[Idea 95](95-shared-webassembly-machine-code.md) reuses executable code and explicitly leaves application initialization. [Idea 98](98-checkpointed-browser-fixtures.md) snapshots an already-running page. Here only the module's specified initial data image is shared; instantiation, imports and the start function still happen each time.

[Idea 107](107-copy-on-write-cloned-arraybuffers.md) must snapshot a live mutable buffer. This proposal has a simpler input: validated module data with a known initial layout, before application execution has mutated it.

## Proposed change

For an eligible validated module, construct an immutable, page-aligned memory image from its active data segments. Apply segments in their specified order, including overlaps, with zero-filled gaps. Key the image by exact module bytes, memory declaration, resolved initialization layout, runtime identity and OS page requirements.

At each instantiation, reserve a fresh linear-memory address range and map that image privately into it. Pages become private on first write. Export a new Memory/ArrayBuffer wrapper with the ordinary logical size and growth behavior. Do not map any prior instance's modified pages into another instance.

Start with module-defined, non-shared memory and constant offsets independent of imports. Imported memories can already contain data and be visible to application code, making replacement unsafe. Imported-global-dependent offsets, shared memories, unsupported memory64/growth modes and unusual allocators use ordinary initialization until explicitly supported.

Keep normal import lookup, validation, element/table setup, globals and start-function execution. A start function that fills the entire memory may erase the benefit, but it must still run. Lazy zero pages already avoid some allocation work; count only copied initialized bytes and other work actually removed.

Build images lazily for sufficiently large or repeatedly instantiated modules. Use a bounded project/browser cache and private mappings, with normal initialization on cache misses, platform limitations or image rejection. [Wasmtime's configuration documentation](https://docs.wasmtime.dev/api/wasmtime/struct.Config.html#method.memory_init_cow) provides useful implementation tradeoffs, but V8's reservation, traps and ArrayBuffer integration require their own design.

## Functional boundary

Preserve exact bytes, segment ordering, bounds traps, independent writes, memory growth, JavaScript views and detached-buffer behavior. Retain validation and initialization failure ordering. The first subset should exclude externally visible imported-memory partial-write cases rather than accidentally making failed instantiation atomic.

OS page sharing must never turn an ordinary memory into SharedArrayBuffer semantics. Keep native memory consumers, fault handling, debugging and cancellation correct. Expose a disable switch and retain the stock-browser path; do not replace V8 execution with Wasmtime merely because it already implements this mechanism.

## Payoff and later decision

Large read-mostly initial data offers both faster instantiation and lower physical memory across workers. Small modules, zero-only memories and workloads that overwrite every page can lose through mapping overhead and write faults. Image creation and first-touch costs belong in the comparison.

Later compare sparse reads/writes, full overwrites, growth, overlapping segments, imported-memory fallback and failing initialization. Run Wasm conformance, page/worker regressions and the [full matrix/upstream procedure](01-browser-native-actions.md#payoff-and-decision-test), adding real data-heavy Wasm apps. Report proportional memory, fault counts and total suite time, including image construction and disposal. Build elsewhere.

**Assessed 2026-10-31:** deferred: browser-internal (V8 Wasm), needs a custom Chromium; no measured test workload instantiates large Wasm modules repeatedly.
