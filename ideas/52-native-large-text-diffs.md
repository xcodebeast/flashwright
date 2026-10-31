# Generate large text failure diffs with compact native data structures

Scope: large text snapshots, generated documents and failures comparing substantial strings. Effort: large for exact output compatibility. Priority: high for diagnostic-heavy workloads; no benefit from already-equal snapshots.

Research, 2026-10-31, against `c4c3583b` and the live worktree. No failures generated or timing runs performed.

## Where the work is

[`compareText`](../packages/utils/comparators.ts) already returns immediately for equal strings. For a mismatch it asks `diff.createPatch` for a complete patch, splits that string into lines, creates another array of colored lines and joins them again. The installed jsdiff version is 9.0.0. Its diff engine maintains an edit-path frontier and component records before patch formatting.

[`expectLibrary.ts`](../packages/playwright/src/matchers/expectLibrary.ts) also calls Jest's diff formatter for some failures. That is a separate adapter and must not be assumed equivalent to jsdiff. [Idea 25](25-indexed-collection-assertions.md) optimizes whether values match; [idea 20](20-incremental-test-report-generation.md) optimizes report assembly. This proposal accelerates construction of the diagnostic itself after a mismatch is known.

## Proposed change

Start with text snapshots only. Represent lines as offsets into the two immutable input strings, with compact numeric IDs for equality comparisons. Intern equal lines with exact content checks; hashes alone cannot establish equality. Keep the edit frontier and traceback in packed arrays or an arena rather than many JavaScript objects.

Implement the heavy sequence-search kernel in Rust/C++ or WASM, retaining the existing JavaScript path below a measured size threshold. Port the installed engine's algorithm and tie-breaking behavior before trying a different algorithm. [jsdiff's documentation](https://github.com/kpdecker/jsdiff) describes its Myers-derived basis and configurable token semantics; a generic native diff library is not automatically compatible.

Return compact edit spans and format hunks directly into the final colored result, avoiding the complete-patch/split/map/join chain. Keep the same five context lines, hunk boundaries and newline handling. The final error string still occupies memory; this is not constant-memory output.

Only after that path is useful, add a separate adapter for [Jest's string-diff semantics](https://github.com/jestjs/jest/tree/main/packages/jest-diff). Object pretty-printing, getters and custom serializers stay on their current path and run exactly as often as before. Do not send live user objects to a native worker for speculative formatting.

## Compatibility boundary

Require identical error text, color behavior, Unicode treatment, line endings, repeated-line alignment and final-newline handling. Preserve arbitrary JavaScript string contents, including lone surrogates; a UTF-8-only conversion must not silently change them. Retain licensing and dependency-version provenance for a port.

The first implementation remains synchronous. Making a synchronous matcher asynchronous to offload work would change the API. Native/WASM code must have bounded scratch allocation and a safe fallback for unsupported sizes or platforms. Do not introduce truncated diffs, a time-limit approximation or a changed assertion result as a performance shortcut.

## Payoff and first decision

The target is sequence-search CPU, temporary object overhead and repeated diagnostic string copies. Completely different or repetitive large texts can be expensive even though small diffs are already fast. Native code does not remove the underlying worst-case search complexity; input copying or module startup can erase a win.

Later compare byte-for-byte output against installed jsdiff on small/large inputs, repeated lines, large edit distances and Unicode. Measure the complete failing assertion, formatting, report delivery and process exit. Include many soft failures and supported shared-worker lanes, where blocking Node affects other tests.

Run snapshot/update, error-formatting and expectation coverage in `tests/playwright-test`, plus `tests/page` on `chromium-page`, against pristine upstream in `workbench/pw-src`. Report a large-text-failure corpus beside the full [benchmark matrix and scenario command](../bench/README.md), including current-fork comparisons under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Reject improvements that only make a kernel faster while whole failures take longer. No execution now.
