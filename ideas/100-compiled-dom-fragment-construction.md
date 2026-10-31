# Compile repeated HTML fragments into fresh-node construction plans

Scope: applications repeatedly inserting large, identical inert HTML fragments through `innerHTML` or related APIs. Effort: very large in Blink. Compatibility: fresh nodes, normal setter behavior and unchanged parsing results.

**Assessed 2026-10-31:** deferred: Blink parser work.

Research, 2026-10-31, against `1f613889` and Chromium main. No parser workloads run.

## Evidence and distinction

Chromium already has an optimized [`HTMLFastPathParser`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/html/parser/html_document_parser_fastpath.cc). It scans source, parses attributes and constructs elements, with explicit eligibility checks. Adding another generic fast HTML tokenizer would duplicate existing work.

The remaining opportunity is to reuse the *result of parsing repeated fragment text*: a compact plan for creating its nodes and attributes. [Idea 80](80-shared-html-tokenization.md) reuses speculative document-scanner tokens during one navigation; it leaves tree building in place. This proposal spans repeated fragment insertions and caches construction instructions. It does not restore live application state like [idea 98](98-checkpointed-browser-fixtures.md).

[`Frame.setContent`](../packages/playwright-core/src/server/frames.ts) uses document writing, not the `innerHTML` fragment path. It should not be counted as an automatic beneficiary. The first target is application-side fragment insertion, which Flashwright runs through the ordinary browser.

## Design

For an eligible first parse, record immutable instructions: element kind, child structure, decoded attribute values and text spans. On an exact-input cache hit, instantiate new document-owned nodes from that plan, then perform the existing insertion operation. Native bulk construction can avoid repeated token objects, entity decoding, tag dispatch and attribute-name resolution.

Start within one renderer and a conservative inert HTML subset. Retain no live DOM nodes or application references. Promote repeatedly used plans to browser-owned storage only if navigation and renderer churn justify serialization and remapping costs.

Key by the exact post-conversion string, context element/namespace, document parsing mode, parser policy and relevant feature flags. Verify exact input after any hash lookup. Establish eligibility before observable work. A rejected plan takes the current parser, without partially inserting a cached tree first.

## Functional boundary

Run Trusted Types checks, string conversion and the public setter's validation on every call. Preserve entity handling, attribute order/duplicates, malformed-markup repair, node ownership and mutation-observer records. Do not replace parser construction with public `cloneNode()` unless its initialization behavior is proven equivalent.

Initially exclude custom elements, scripts, event-handler attributes, active resource elements, declarative shadow roots and context-sensitive form/table cases. Cached parser decisions must not bypass current custom-element definitions, base URLs, policies or loading behavior. Add each category only with explicit semantics.

Node allocation, insertion hooks, style invalidation and layout still occur. Existing template cloning and framework template caches may already avoid parsing; those workloads are controls, not claimed wins. Bound retained strings/plans and stop caching high-cardinality input.

## Payoff and later decision

The target is repeated parsing plus construction dispatch for large stable fragments. Small fragments already have a fast path, and React-style element-by-element construction does not benefit. Plan lookup and fresh-node allocation set a hard floor.

Later compare repeated versus unique fragments, existing template clones, Unicode/entities and unsupported inputs. Differentially check exact DOM, mutations and application output against Blink's parser. Use Blink parser tests, `tests/page` on `chromium-page`, runner regressions and the [full matrix/current-fork comparison](01-browser-native-actions.md#payoff-and-decision-test) against pristine upstream. Measure full insertion-to-assertion latency and cache memory, not parsing alone.
