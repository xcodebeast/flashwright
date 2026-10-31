# Collect coverage from counters that changed instead of scanning every counter

Scope: action-dense coverage runs over large Istanbul-instrumented apps, where each action executes a small part of the code. Effort: large, including an optional instrumentation adapter. Potential: make repeated coverage collection proportional to touched counters. This requires an explicit application-build integration.

**Assessed 2026-10-31:** deferred: only coverage runs.

Research proposal, 2026-10-31. No instrumentation, application builds or experiments performed.

## Evidence and distinct opportunity

[`CoverageScript._takeCurrent`](../packages/injected/src/coverageScript.ts) visits every file in `window.__coverage__`. [`takeCounters` and `takeBranchCounters`](../packages/isomorphic/istanbulCoverage.ts) enumerate all statement, function and branch counters, emitting and resetting the nonzero ones. The wire result is already sparse, and maps are already sent once per file per script instance. The remaining cost is discovering which counters changed.

This work can repeat within one test: [`Tracing._captureSnapshotNow`](../packages/playwright-core/src/server/trace/recorder/tracing.ts) calls the coverage collector at the after-action capture phase when coverage recording is active. For an app with `C` counters and `K` collections, discovery can inspect approximately `K × C` entries even when only a small subset was hit. Fresh documents also repeat file-map registration. [`CoverageRecorder`](../packages/playwright-core/src/server/coverageRecorder.ts) merges the collected deltas into ordinary Istanbul output.

[Idea 78](78-browser-owned-unload-coverage-mailbox.md) changes where unload coverage is stored. [Idea 47](47-jit-compatible-precise-coverage.md) concerns V8 precise coverage. This proposal changes Istanbul's counter-write and collection algorithm, leaving unload delivery and V8 coverage separate.

## Proposed change

Offer a versioned Flashwright extension to an Istanbul-compatible instrumentation pass. Keep the normal counters and source mappings, but register each file's stable counter IDs and maintain a private list of counters touched since the last collection. On the first increment in a collection epoch, record that counter's ID. Later increments update the count without appending duplicates.

Collection walks the touched IDs, emits the same counts and clears those entries. Preserve whole branch arrays where the current delta format requires them. Register each loaded file once even when no counter was hit, so zero-coverage files remain present. Keep the current collector for ordinary instrumentation and files that lack the extension.

Use a small dense bitmap or epoch table to prevent duplicate dirty entries, with packed IDs and a bounded list. Do not install JavaScript Proxies around every counter: interception on every application statement could cost more than the scan it removes. The [Istanbul instrumenter](https://github.com/istanbuljs/istanbuljs/blob/main/packages/istanbul-lib-instrument/api.md) is the build-time integration point to investigate.

Stage the work: first add touched-counter metadata while preserving ordinary counter objects and output. Only consider denser counter storage or content-addressed map sharing after measuring that stage. They are not prerequisites for proving sparse discovery.

## Compatibility boundary

Preserve exact statement/function/branch counts, instrumentation locations, source maps, exception behavior and the order of original application effects. Counter values must retain JavaScript number semantics; a convenient 32-bit counter must not wrap. Collection and reset must be atomic relative to instrumentation in the same realm.

External code can inspect or mutate `__coverage__`. Directly resetting counters without updating dirty metadata breaks this scheme. Define the supported integration contract explicitly; retain ordinary collection when another coverage tool owns resets or when generated code is unrecognized. Do not silently replace ordinary coverage objects with incompatible lazy views.

Handle dynamically loaded files, changed code at the same path, multiple realms, navigation, retained/discarded trace policy and cancellation. Document the extra instrumentation and its disable switch. The collector must never lose a hit merely to produce a smaller payload.

## Payoff and later decision

The target is discovery proportional to distinct touched counters plus required file registration. There is a real tradeoff: every executed counter acquires extra bookkeeping. Sparse, large apps may win substantially; tight computational loops and nearly complete coverage may lose. Measure total instrumented application time, not just collection time.

Later compare ordinary instrumentation with sparse instrumentation on many actions within one document, branch-heavy loops, large mostly untouched bundles and short navigations. Require identical final Istanbul JSON/LCOV results and coverage retention behavior. Run coverage/trace regressions, `tests/page` on `chromium-page` and runner tests against pristine upstream. Report instrumented workloads separately beside the [full matrix](../bench/README.md), including build cost, all collection/reset work and memory. Stop if hot-path overhead outweighs collection savings.
