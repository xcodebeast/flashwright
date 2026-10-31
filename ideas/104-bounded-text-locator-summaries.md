# Match literal text without building every ancestor's full string

Scope: large, deeply nested documents and literal `getByText` / `hasText` locators. Effort: large; an initial version needs no browser fork. Potential: reduce repeated string scanning, flattening and allocation within one query.

Research, 2026-10-31, against `913231d4` and the live worktree. No DOM workloads or measurements run.

## Evidence and distinction

[`computeElementText`](../packages/injected/src/selectorUtils.ts) recursively builds `full` text for nodes and their ancestors. The fork already computes normalized text lazily, skips excluded subtrees cheaply and caches results during an evaluation. [`createTextMatcher`](../packages/injected/src/injectedScript.ts) still compares complete normalized strings, or lowercases them for literal substring matching.

Nested elements can describe nearly the same large text repeatedly. V8 may initially represent concatenation as ropes, so concatenation alone is not proof of copying. Normalization and case conversion still need to inspect relevant characters when each ancestor is matched.

[Idea 05](05-incremental-locator-indexes.md) reuses work between queries. [Idea 65](65-cardinality-aware-selector-execution.md) avoids unnecessary matches. Here every requested match is computed, with a smaller representation of each subtree's text. This also works on a cold query after arbitrary DOM changes.

## Proposed change

Compile a supported literal needle into a query-specific text matcher. Traverse text nodes once and combine bounded summaries from children instead of materializing every ancestor's full text.

For substring matching with a needle of length `m`, retain whether a fragment already matches, its first and last at most `m - 1` normalized characters, and enough length/whitespace state to join it to adjacent fragments. A match spanning two fragments must occur in their suffix/prefix combination. For exact matching, retain a length capped beyond `m` and at most the candidate characters needed to prove equality. Never use a probabilistic hash as the final equality decision.

Whitespace handling is part of the algorithm. [`normalizeWhiteSpace`](../packages/isomorphic/stringUtils.ts) removes two specific characters, trims, then collapses whitespace. Summaries must preserve boundary whitespace until concatenation is complete. Independently trimming each child would turn `"hello " + "world"` into the wrong text.

Start with short ASCII literals and ASCII text. Lax matching uses JavaScript's whole-string lowercase semantics; Unicode context-sensitive case conversion cannot be replaced with arbitrary fragment conversion. Unsupported text, long needles and regular expressions use the existing path. A failed eligibility check must retain enough information for correct fallback.

Compute the same self-versus-child match classification used by `elementMatchesText`. Keep separate handling for immediate text fragments, input button values, excluded tags, document head and shadow roots. Consumers that actually request full text still receive the existing representation.

## Functional boundary

Preserve empty-string behavior, adjacent text nodes, comments, shadow traversal, strict/internal text differences and ordered results. Keep all summaries local to the evaluation. Do not substitute `innerText`, whose layout-dependent behavior differs from the current text rules.

Use a separate matcher module with a small marked hook in the existing engine. The current implementation remains the fallback and differential reference.

## Payoff and later decision

For bounded `m`, aim for work proportional to original text plus per-node summaries, instead of repeatedly scanning text for each containing ancestor. The benefit depends on nesting and which strings today's lazy path actually touches. Flat short labels may be faster already.

Later compare literal queries on nested articles, large tables, absent needles, whitespace boundaries and Unicode fallback cases. Require identical lists and diagnostics in text/get-by/filter tests, then follow the [full matrix and upstream regression procedure](01-browser-native-actions.md#payoff-and-decision-test). Include allocation and retained-memory costs. Do not generalize an ASCII win to regex or arbitrary Unicode without separate evidence.

**Assessed 2026-10-31:** measured, candidate. On a 3,000-element nested page (depth ~15), a literal `getByText` costs 3.4-4.9 ms per query against 1.1 ms for a CSS locator; a renderer profile shows ~1 ms of GC per query from building and normalizing the text of every ancestor. Exactness traps for a bounded version: whitespace normalization across element boundaries, and lowercasing that is not compositional (Greek final sigma), so it needs a full-string fallback for non-ASCII needles or text.
