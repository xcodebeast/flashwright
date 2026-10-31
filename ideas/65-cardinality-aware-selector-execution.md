# Stop selector execution once its caller has enough matches

Scope: large pages using first/nth locators, nested has filters and existence checks. Effort: large. Priority: promising algorithmic work without a browser fork.

**Assessed 2026-10-31:** deferred. Strict mode needs every match to report ambiguity, so only `first()`/`nth()` and `has` filters could stop early; the role, label and text engines were already reworked (`0caa96cc`, `4f2200f4`).

Research, 2026-10-31, against `2bc2768b` plus the live worktree. No page loads or measurements.

## Evidence and opportunity

[`InjectedScript.querySelector`](../packages/injected/src/injectedScript.ts) calls `querySelectorAll` even when it needs only the first match. `_queryNth` converts a complete Set to an array before taking one entry. The `internal:has` and `internal:has-not` engines also call the full-query path just to obtain a boolean.

Consequently, a broad nested locator can enumerate and allocate many matches that its caller immediately discards. Existing evaluator caches help repeated calculations within a query, but do not turn a complete result into an existence query. [Idea 05](05-incremental-locator-indexes.md) retains indexes across calls; this proposal changes how much one call computes and retains no cross-call DOM state.

## Proposed change

Introduce internal result requirements: all matches, first match, existence, a nonnegative nth match, or enough matches to decide uniqueness. Pass that requirement into eligible built-in selector engines through an ordered visitor or iterator.

Start with `internal:has` over simple built-in selectors. Stop at the first valid descendant. Then support terminal `.first()` and nonnegative `.nth(k)`, stopping after k + 1 matches in the exact existing order. Keep native `querySelectorAll` for cases where a JavaScript traversal would cost more than the avoided allocations.

A strict selector can stop the successful path after establishing zero/one/multiple candidates, but a multiple-match error still needs today's complete diagnostic. Continue the same enumeration synchronously when needed. Do not rerun user engines or defer diagnostics until the DOM may have changed.

Push limits through a selector plan only where valid. A later filter can discard earlier candidates; unions need ordered deduplication; layout selectors rank by distance; negative nth needs the tail. Such stages may require full materialization. Validate the complete selector before execution so an early match cannot hide an invalid later part.

## Compatibility boundary

Preserve DOM/shadow traversal order, root exclusion, strictness errors, selector warnings, frame boundaries and detachment handling. Custom engines can have observable side effects and must retain their existing invocation and enumeration behavior. Start with built-ins whose traversal is known to be safe; fallback before any effectful engine runs.

Keep the evaluator's begin/end cache lifetime balanced on early exit. Do not retain DOM nodes after the call. This is not permission to return the first candidate before checking required actionability or to weaken strict selectors.

## Payoff and later decision

For an eligible existence check with an early match, work can fall from enumerating a whole subtree to finding that match. Missing matches still require a full search. Benefits should grow with large matching sets and repeated nested filters, with fewer temporary arrays and Sets as well as less renderer work.

Later compare complete match order, warnings and errors against the current engine, including no matches, late matches, shadow roots, unions, custom engines and nested nth. Use selector/get-by/queryselector tests and upstream `tests/page` on `chromium-page`, plus runner regressions against pristine upstream. Report the full [matrix](../bench/README.md) and current-fork comparisons, adding large nested-locator workloads under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Reject a JavaScript iterator that slows ordinary native CSS queries. No validation runs now.
