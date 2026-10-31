# Index the active ancestor path during deep equality

Scope: assertions over deeply nested JSON, syntax trees and cyclic object structures. Effort: medium to large because the comparator's behavior must remain exact. Potential: remove quadratic cycle-detection work without changing which values compare equal.

**Assessed 2026-10-31:** deferred: only very deep or cyclic structures in equality assertions.

Research, 2026-10-31. Installed dependency and source inspection only; no generated graphs or benchmarks.

## Evidence and difference from existing ideas

[`expectLibrary.ts`](../packages/playwright/src/matchers/expectLibrary.ts) uses `equals` from Jest's expect utilities. In the installed `@jest/expect-utils/build/index.js`, `eq` scans both ancestor arrays backward before descending into another object. [Jest's corresponding implementation](https://github.com/jestjs/jest/blob/main/packages/expect-utils/src/jasmineUtils.ts) shows that this scan exists to detect cycles at matching depths.

Comparing two acyclic chains of depth D can therefore perform roughly D × (D − 1) / 2 ancestor-position checks, before counting key comparisons. A wide shallow object has a different cost profile.

[Idea 25](25-indexed-collection-assertions.md) reduces candidate searches in arrays, Sets and Maps. This proposal leaves their matching order alone and optimizes the active recursion path of one equality comparison. [Idea 76](76-native-binary-equality-assertions.md) handles byte-array leaves, a separate cost.

## Proposed change

Keep the current traversal and add two maps from object identity to active stack depth. Push and remove entries alongside the existing ancestor arrays. Lookups identify whether either operand is already on its side's path without scanning all ancestors.

Reproduce the reverse scan exactly, including which side wins when both operands occur on the path. Store the depth, not merely a boolean. The old code checks the left operand first at each descending position; the replacement must produce the same answer if the right operand is found deeper than the left.

Allocate the maps only after a small depth threshold, seeding them from the current stacks. Shallow comparisons keep the cheap existing loop. Release the maps with the comparison; they must not retain application objects after an assertion.

First change the ordinary object/array comparator only. Iterable equality has its own copied ancestry and custom-tester recursion. Integrate that later as a distinct milestone if needed, without changing collection search or introducing a global recursion state.

## Compatibility boundary

An active-path index is not a cache of completed object pairs. Repeated aliases in different branches must still be visited normally. Getters, proxies and custom equality testers can have effects, so skipping a previously equal pair would change behavior.

Preserve key enumeration, property access order, asymmetric matchers, custom tester calls, strict/loose distinctions and short-circuit behavior. Nested calls through a tester's `this.equals` need their own comparison state unless the current algorithm explicitly passes ancestry. Clean up correctly on false results and exceptions.

Do not combine this with an iterative traversal rewrite in the first patch. Extending the recursion limit changes another behavior and makes parity harder to assess. Package the adapted comparator as maintained source with the required upstream license and small integration hooks, not an installed-dependency edit.

## Payoff and later decision

The ancestor-checking component moves from O(V × D) toward expected O(V), with O(D) auxiliary state. Property traversal and collection comparisons remain. This can matter for large tree-shaped payloads while contributing little to ordinary primitive assertions.

Later compare results and observable getter/tester sequences on acyclic chains, branching trees, unequal cycle depths and shared aliases. Include shallow small objects to set the crossover threshold. Measure complete assertions and allocation costs, not only map lookup throughput.

Apply the [full matrix and upstream regression procedure](01-browser-native-actions.md#payoff-and-decision-test), including built-in/custom matcher tests, current-fork controls and deep-object workloads. No execution on the busy machine.
