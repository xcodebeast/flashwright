# Maintain locator indexes instead of rescanning the DOM

**Priority:** high for large applications · **Scope:** role/text locators and repeated assertions · **Effort:** large; reliable broad invalidation may require Blink hooks.

Research proposal, 2026-10-29. No new measurements. Flashwright's existing reactive waits reduce sleeping; they still have to reevaluate selectors when they wake.

## Remaining cost

[`queryRole`](../packages/injected/src/roleSelectorEngine.ts) iterates `querySelectorAll('*')` across the scope and shadow roots, checking role and accessible name/description. [`SelectorEvaluatorImpl.end`](../packages/injected/src/selectorEvaluator.ts) clears query and text caches at the end of the retained evaluation. [`endAriaCaches`](../packages/injected/src/roleUtils.ts) similarly discards accessible-name and role caches when the outer scope ends.

These caches already prevent duplicate work **within** evaluations. The opportunity is retaining valid work **between** actions and assertion retries. With a large mostly static DOM, recomputing the same names and traversing every element can dominate even when there is no polling delay.

## Proposed mechanism

Maintain per-document indexes for frequently queried selector classes: roles, test IDs and normalized text candidates. Compile the parsed locator into a query plan that narrows candidates early, then uses the existing matcher for exact semantics. Preserve document/shadow traversal order and strictness checks. Build indexes lazily after repeated queries; a one-off lookup on a small page should retain the current cheap path.

Attach generation numbers to relevant state: DOM structure, text/attributes, form values, style/layout, focus and accessible-name dependencies. Invalidate affected entries and dependent names rather than the whole document. `aria-labelledby` and `aria-describedby` require reverse references; ancestor state and inherited visibility can invalidate a subtree. Detached nodes must leave indexes without pinning entire old documents.

A safe first milestone caches only structurally defined candidates with conservative invalidation and recomputes dynamic values at each query. Then add retained accessible-name results where validity is established. Unsupported custom selector engines use the current implementation. Assertion retries can subscribe to a query's dependencies while retaining fallback wakeups for changes that are not observable through those subscriptions.

## Hard part: knowing when an answer is stale

A MutationObserver alone is insufficient. `input.value = ...`, selection, CSSOM edits, adopted stylesheets, fonts, media queries, focus/hover states, slot assignment and animations may change a locator's answer without a useful DOM record. Drain pending records before queries and invalidate conservatively; native style/form/accessibility generation hooks are the stronger long-term solution. Do not substitute Chromium's accessibility-tree names for Playwright's own role/name rules without proving equivalence.

## Payoff and decision test

**First experiment:** index structural candidates for role queries in an ordinary document, using a conservative superset of possible matches rather than caching final roles. Recompute roles, names, visibility and live state on each query; fall back for shadow trees initially. Compare ordered results with the uncached engine after every mutation and property change.

For `Q` repeated queries over `N` nodes, the target is replacing repeated `Q × N` traversal with initial indexing plus changed-node maintenance and exact candidate checks. This could lower renderer CPU as well as latency. It is an algorithmic opportunity, not a promised speedup: mutation-heavy pages and broad substring/regex queries can erase the advantage. Bound caches by document and query budget; automatically use the uncached path when maintenance costs more.

When resources permit, compare small/large DOMs, static/churn-heavy pages, virtualized lists, shadow trees and cross-frame locators. Include first-query cost and retained memory, then follow the [full matrix and old-fork comparison procedure](01-browser-native-actions.md#payoff-and-decision-test). Run `tests/page` on `chromium-page`, particularly [`selectors-role.spec.ts`](../tests/page/selectors-role.spec.ts), text/CSS/frame/custom-selector suites and relevant assertions, against pristine upstream. Differentially compare every match list, order and error after adversarial non-DOM state changes. Any stale result is a blocker, even if ordinary benchmarks get faster.
