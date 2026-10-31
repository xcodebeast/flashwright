# Select tests before building redundant project suite trees

Scope: large generated suites, many projects, deep describes and narrow selections. Effort: large. Priority: promising for collection-bound runs; no new test format required.

**Assessed 2026-10-31:** deferred. Measured on 5,000 tests in 100 files with 3 projects, listed with a grep that selects 3: binding and filtering the project suites takes 47 ms of 380. Loading the files takes 138 ms, about half of it source-mapping each declaration's location (each file's source map is parsed and sorted once, ~0.5 ms per file). A typical suite spends a few milliseconds on either.

Research, 2026-10-31, against `95f3e831` and the live worktree. No test modules imported or collection commands executed.

## Evidence and distinct opportunity

[`createProjectSuite`](../packages/playwright/src/runner/loadUtils.ts) binds every collected file to a project before applying project grep. [`bindFileSuiteToProject`](../packages/playwright/src/common/suiteUtils.ts) deep-clones that file, constructs IDs and walks each test's parent chain for inherited settings. If additional filters exist, `filterProjectSuite` makes another deep clone before pruning it. Repeats can create further copies.

[`Suite._deepClone`](../packages/playwright/src/common/test.ts) clones each suite/test through its serialization/parsing helpers. This is object reconstruction, not necessarily JSON stringify/parse. Several complete representations can exist even when a command ultimately selects a handful of tests.

[Idea 13](13-scalable-test-file-discovery.md) reduces directory scanning, [idea 12](12-native-test-transformation.md) changes source transformation, and [idea 41](41-declarative-test-collection-manifests.md) avoids imports through a new declaration format. This proposal keeps ordinary imports and their side effects, then reduces internal selection and cloning work.

## Proposed change

Keep the collected file tree as the authoritative input during internal selection. Compute project-specific membership using compact masks or selected-entry lists. Carry inherited timeout/retry/annotation/lock information down a traversal instead of repeatedly walking every ancestor from each test. Preserve the existing annotation order and override rules.

Keep separate masks for unfiltered dependency projects and filtered top-level projects, allowing both views without cloning both trees. Materialize ordinary Suite/TestCase instances only for the entries needed at the next observable boundary. Preserve original entry order, parent links and exact test-ID construction.

Begin by replacing the second clone in `filterProjectSuite`, leaving earlier binding and all later phases intact. Then move safe built-in filters ahead of project binding. This staged approach can demonstrate reduced allocations without rewriting the entire runner at once.

Do not collapse distinct selection phases merely to claim a single pass. Grep, location filters, `.only`, dependency expansion, repeats, reporter preprocessing and sharding have an established order. In particular, [`createRootSuite`](../packages/playwright/src/runner/loadUtils.ts) calls `reporter.preprocess` before sharding. Materialize its full required view before that callback, even if most tests will subsequently belong to another shard.

## Compatibility boundary

Reporters must receive the same mutable public objects, not proxy facades or shared project state. The [Reporter API](https://playwright.dev/docs/api/class-reporter#reporter-on-begin) exposes the suite to user code. Preserve identity across callbacks and isolate annotations/results between projects and repeat indices. Rebuild internal selection metadata if an allowed preprocessing mutation invalidates it.

Preserve duplicate-title/import errors and their timing, forbidOnly behavior, setup/teardown selection, stable IDs, tags, source locations and serial grouping. Arbitrary filters that inspect or mutate TestCase instances keep the existing materialized path. Do not skip file execution because no declaration was selected last run.

## Payoff and later decision

The opportunity scales with collected tests multiplied by projects, extra clone passes and suite depth. A narrow run in a large matrix can avoid constructing many discarded objects. Full unfiltered runs still need their public test objects, and expensive imports remain. Masks and metadata have costs; small suites should retain a simple path if it is faster.

Later compare collected IDs, metadata and reporter observations on large/project-heavy suites, with narrow grep, `.only`, repeats, dependencies, sharding and preprocessing. Measure full collection/run time, allocations and peak RSS, including final materialization. Reject savings that merely defer equivalent work into `onBegin`.

Run collection/filter/project/reporter coverage in `tests/playwright-test` and `tests/page` on `chromium-page`, comparing failures with pristine upstream in `workbench/pw-src`. Report the full [matrix](../bench/README.md) plus large-suite rows and current-fork controls under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No execution now.
