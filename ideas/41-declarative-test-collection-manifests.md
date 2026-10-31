# Collect tests from declarative manifests

**Scope:** large suites with expensive imports, generated cases and frequent narrow selections. **Effort:** large for an explicit format; very large for compiler support. **Priority:** high where collection, rather than browser execution, dominates.

Research proposal, 2026-10-31. No test imports or measurements. This avoids collection-time module execution for an opt-in declaration format. [Native transforms](12-native-test-transformation.md) make compilation faster; [file discovery](13-scalable-test-file-discovery.md) finds paths. Neither removes executing modules to discover tests.

## Evidence

[`loadTestFileOnce`](../packages/playwright/src/common/testLoader.ts) establishes the current suite and calls `requireOrImport(file)` to collect declarations. [`WorkerMain.runTestGroup`](../packages/playwright/src/worker/workerMain.ts) loads the module again in its separate process before filtering to assigned IDs. Per-process suite and module caches exist, so this is not repeated execution on every test; the duplication spans collection and worker processes.

Ordinary declarations can contain arbitrary JavaScript, including [parameterization loops](https://playwright.dev/docs/test-parameterize). Skipping their execution transparently would lose tests or side effects. The opportunity is a different, explicit declaration boundary, not caching the last observed Suite and hoping it remains valid.

## Proposed change

Define a static manifest containing the information needed to construct suites: test IDs/titles, source locations, tags, annotations, options, serial/parallel grouping, hook references and fixture definitions/dependencies. Test bodies and hook/fixture implementations are named module exports loaded only by executing workers.

The manifest is authoritative input. For example, a generated matrix can describe thousands of cases as data and reference one implementation export with different serializable arguments. Filtering, sharding, listing and reporting operate on those declarations without importing database clients, page objects or other execution dependencies.

A compiler can later generate manifests from an explicitly restricted declaration module. Only statically resolvable declarations belong in that mode; arbitrary calls, environment-dependent branching and top-level await retain normal collection. Do not extract declarations from unrestricted JavaScript through a speculative execution that has hidden side effects.

Retain normal filesystem discovery so new files cannot disappear behind an old manifest. Generated manifests need complete input identities, including configuration and generators. Reject stale or mismatched inputs before selection. Workers verify implementation identity and exported entrypoints before running a body. This is not a test-result cache: every selected test still executes.

## Compatibility

Collection-time side effects deliberately disappear for manifest-backed tests, and import failures may be discovered at a different phase. Document that execution model in README and keep ordinary modules as the opt-out. It is unsuitable for suites whose declaration code writes shared state or discovers cases from live services without an explicit generation step.

Preserve stable IDs, duplicate-title validation, fixture scope/dependency errors, hook order, retries, parameter values, source maps and reporter metadata. Reproduce supported closure state through explicit data or worker module state; do not serialize arbitrary closures and pretend they are equivalent. Normal and manifest-backed files must coexist without changing the former's import order or environment.

## Payoff and later decision

Savings are collection-only imports and module initialization, multiplied across repeated invocations and CI shards. A one-test selection could avoid loading implementation dependencies for thousands of unselected tests. Worker imports still occur, and parsing/validating a huge manifest has a cost. Small suites with cheap imports may gain nothing.

First support a hand-authored manifest and one exported implementation module. Compare collected IDs/options and the worker fixture/hook sequence with an equivalent ordinary suite. Then add generated cases, changed inputs, missing exports, duplicate IDs and mixed-mode selection. Measure cold/warm collection and complete runs; include manifest generation when it belongs to the invocation.

Later run collection/filter/shard/fixture/reporter coverage, `tests/playwright-test` and `tests/page` on `chromium-page` against pristine upstream in `workbench/pw-src`. Add a large-import corpus beside `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and the full `node bench/matrix.mjs`, reporting manifest mode separately with a current-fork ordinary-module baseline under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No generators or test modules are executed now.
