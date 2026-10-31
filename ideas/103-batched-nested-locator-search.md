# Search overlapping locator scopes once

Scope: large trees, nested component containers and repeated `filter({ has })` / `hasNot` queries. Effort: large, initially entirely in the injected TypeScript engine. Potential: remove repeated traversal within one locator evaluation.

Research, 2026-10-31, against `913231d4` and the live worktree. Source inspection only; no tests or benchmarks run.

## Evidence and distinction

[`InjectedScript.querySelectorAll`](../packages/injected/src/injectedScript.ts) executes each selector part separately for every current root. `_createHasEngine` and `_createHasNotEngine` start a nested query for each candidate. The evaluator caches some work, but queries with different scope objects still ask about different subtrees.

When candidate roots overlap, the same descendants can be visited many times. Consider nested document sections, all filtered for a matching button near the bottom. The cost can follow the sum of all candidate subtree sizes, rather than the size of their union. Disjoint table rows do not automatically have this problem.

[Idea 05](05-incremental-locator-indexes.md) retains indexes between calls. [Idea 65](65-cardinality-aware-selector-execution.md) stops individual searches early. This proposal shares a complete search across multiple roots within the current call. It also helps unsuccessful `has` searches and successful `hasNot` searches, where early termination cannot help.

## Proposed change

Recognize a conservative selector shape: built-in outer candidates followed by `has` or `hasNot` containing a root-independent tag/attribute/test-id predicate. Query the union of candidate scopes once. During traversal, assign entry/exit positions to each outer candidate and record matching descendant positions.

Determine whether each candidate interval contains a matching descendant using ordered positions, a sweep, or prefix counts. Exclude the root itself wherever the current inner query does. Return candidates in their original order, with the same deduplication and complete strictness diagnostics. Avoid walking upward from every match through every ancestor, which could recreate the original quadratic work.

Start with ordinary DOM trees and simple inner selectors. Keep `:scope`, relative combinators, nested `nth`, layout selectors, frame transitions and custom engines on today's path until there is a proven scope transformation. General CSS cannot simply be evaluated globally and filtered afterward: changing its scope can change its answer.

Allocate the plan and intervals only for sufficiently numerous, overlapping candidates. A short native CSS query or disjoint scope set should keep the direct path. Discard all node references when this evaluation ends. No mutation tracking or persistent index is required.

## Functional boundary

Preserve validation errors even when a candidate set is empty. Do not reorder or consolidate custom-engine invocations; they can execute user code. Keep the original cache lifetime, root inclusion rules, result order, strict-selector errors and detached-tree behavior. Shadow-root traversal needs its own containment model before support is added.

The first version should change only a side-effect-free built-in subplan inside one synchronous query. It must not cache answers across application turns or assume DOM containment and shadow-inclusive containment are interchangeable.

## Payoff and later decision

For overlapping scopes, the target is one union traversal plus interval bookkeeping instead of repeated subtree walks. Temporary memory becomes proportional to the visited tree and candidates. Small pages and disjoint scopes may gain nothing or lose to planning overhead.

Later compare deeply nested containers, missing inner matches, dense matches and ordinary flat rows. Differentially compare complete result lists and errors against the current engine, then run selector/filter coverage and the [full matrix and pristine-upstream procedure](01-browser-native-actions.md#payoff-and-decision-test). Count plan construction and disposal. Reject this if it merely moves traversal into an equally expensive containment loop.

**Assessed 2026-10-31:** deferred. Helps only overlapping `has`/`hasNot` scopes on large trees. On a 3,000-element nested page a `filter({ hasText })` query costs 2.1 ms end to end (CSS 1.1 ms), so repeated traversal of overlapping roots is not where locator time goes today. Revisit with a real app that nests `has` filters.
