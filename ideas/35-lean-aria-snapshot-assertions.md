# Render ARIA assertion diagnostics only when needed

**Scope:** accessibility snapshot suites, large pages and repeated ARIA assertion checks. **Effort:** medium for conditional rendering; large for a compiled matcher. **Priority:** high within this workload.

**Status:** implemented (`d5a7da6c`): a passing check no longer renders the received snapshot, and node boxes are computed on demand. A passing assertion on the 400-row inventory table: 78 -> 57 ms. Building the tree itself (mostly accessible names, ~70%) remains.

Research proposal, 2026-10-31. No measurements. This targets the ARIA assertion pipeline, independently of [locator indexes](05-incremental-locator-indexes.md), [trace snapshots](07-incremental-trace-recording.md) and [collection equality](25-indexed-collection-assertions.md).

## Evidence

[`matchesExpectAriaTemplate`](../packages/injected/src/ariaSnapshot.ts) builds the accessibility snapshot, matches the template, converts the tree to JSON, then renders YAML twice: ordinary text and strings converted to regular expressions. Both forms are produced even when the assertion already passes.

[`Frame.expect`](../packages/playwright-core/src/server/frames.ts) returns without a result payload on success. On unsuccessful checks, it logs the raw YAML and retains the last received value. [`toMatchAriaSnapshot`](../packages/playwright/src/matchers/toMatchAriaSnapshot.ts) needs the regex form for baseline generation/update, while ordinary failure formatting uses the raw form. Thus removing all failure snapshots would be wrong, but always generating both forms is unnecessary work.

The matcher also copies child/template arrays in `containsList` and repeatedly removes the first child with `shift()`. Nested templates can revisit the same tree/template pair. The engine's exact cost depends on its array implementation; source alone does not establish a quadratic runtime for every case.

## Proposed change

Pass a private diagnostic requirement with the assertion: whether baseline generation can be needed, plus negation. Separate tree construction, predicate matching and rendering.

For an ordinary successful assertion, skip the JSON and YAML representations if no consumer needs them. For a failed check, retain the raw YAML required by the existing call log and last-result handling. Produce regex YAML only when baseline generation/update requires it. Decide using `matches !== isNot`, not positive matching alone. Trace/debug consumers that require the old payload keep it.

Then replace array copying/shifting with cursors, preserving the exact ordered-subsequence rules. Compile immutable template predicates once per assertion. Memoize repeated `(tree node, template node, match mode)` evaluations only within one captured tree, with a memory cap; rebuild on each retry. This can avoid repeated nested searches without maintaining another DOM index.

## Compatibility

Preserve matching order, text normalization, regex behavior, contain/equal/deep-equal modes, accessible-name rules and negated assertions. Keep baseline YAML byte-compatible, including generated regex escaping. Missing baselines, update modes, aborts and soft errors still need their current output.

Never defer capture until after failure: navigation or DOM changes could replace the state that actually failed. Preserve every currently visible call-log value. If rendering is moved to Node later, transfer an immutable snapshot of that same check, not live nodes. Do not cache results across DOM changes or use browser AX semantics as a substitute.

## Payoff and later decision

Passing checks can avoid three representation passes and their transfer allocations; ordinary failures can avoid the regex pass. Deep templates may also benefit from bounded memoization. Accessibility-tree construction remains, so gains depend on the share spent rendering/matching rather than discovering names and roles.

First change only rendering selection. Later compare pass/fail results, complete logs and baseline bytes for large trees, retries, negation and every update mode. Assess the cursor and memoization changes separately, including broad patterns with few reusable subproblems.

When the machine is free, run `tests/page/to-match-aria-snapshot.spec.ts`, runner ARIA file/update coverage, all `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Add ARIA-heavy rows beside `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and the whole `node bench/matrix.mjs`, with current-fork comparisons under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test).
