# Avoid quadratic searches in large collection assertions

**Scope:** API assertions over large arrays, Sets and Maps. **Effort:** medium for primitive arrays, large for structured collections. **Priority:** high on large-data suites.

Research proposal, 2026-10-29. No implementation or measurements. This targets equality computation, not locator queries, assertion polling, fixture plans or report generation.

## Evidence

[`ArrayContaining.asymmetricMatch`](../packages/playwright/src/matchers/expectLibrary.ts) checks every expected item with `other.some(equals)`. Disjoint or late-matching arrays can require the product of their lengths in equality calls. The same file imports Jest's `iterableEquality`; the installed `@jest/expect-utils/build/index.js` contains nested scans for structurally equal Set values and Map keys when identity lookup fails. See also [Jest's source](https://github.com/jestjs/jest/blob/main/packages/expect-utils/src/utils.ts); the installed dependency, not future upstream main, is the implementation baseline.

Primitive Set/Map identity lookups already exist. The opportunity is repeated array membership and object-valued collections, not replacing a native hash lookup with another one.

## Design

Start with large primitive-only `arrayContaining` operands. Build a membership index once, retaining distinctions required by the existing equality function, particularly `+0` versus `-0`. `NaN`, symbols, sparse arrays and inherited array entries need explicit handling. Preserve the current existence semantics: duplicate expected items do not automatically require distinct received items.

For plain-data object collections, explore structural fingerprints that select candidate buckets. A fingerprint is only a filter; verify every possible match using the existing exact comparator. Equal values must always share a bucket, while collisions merely cost extra comparisons. Normalize according to the selected matcher: loose equality, strict equality and asymmetric matchers cannot share an assumed universal hash.

Keep indexes local to one synchronous assertion. Caching mutable objects between assertions would require invalidation and could turn a failure into a pass. Cap scratch memory and use the existing algorithm for small or collision-heavy collections.

## Compatibility and payoff

Eligibility is the hard boundary. Getters, proxies, custom iterators, asymmetric matchers and custom equality functions may observe comparison order/count. Pre-scanning them is not transparently safe. A first implementation should use a narrowly proven side-effect-free subset and fall back before invoking user code; even proxy detection and descriptor inspection must be designed without triggering traps. If this cannot be proved, do not broaden the subset.

Preserve current Set/Map matching semantics, including whether the same structurally equal candidate can satisfy multiple entries; do not silently impose bijective matching. Keep failure messages, `.not`, soft assertions and custom matcher behavior unchanged. Hash equality alone must never pass an assertion.

For well-distributed eligible data, the target is near-linear indexing plus a small number of exact comparisons instead of quadratic search. Pathological collisions remain quadratic; benchmark them. Browser-bound tests with tiny assertion payloads will not materially improve.

## Later decision test

Differentially compare results and diagnostics across random/adversarial collections, duplicates, missing/undefined keys, holes, signed zero, symbols, cycles and asymmetric values. For unsupported objects, compare observable access sequences as well as results.

Later run [`expect-builtins.spec.ts`](../tests/page/expect-builtins.spec.ts), custom/soft matcher coverage, all `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report `node bench/run.mjs <scenario> <workers> <iterations> stock,fork`, `node bench/matrix.mjs`, large-collection rows and the current-fork baseline under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No tests now.
