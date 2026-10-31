# Parse repeated JSON once and construct fresh results from a plan

Scope: applications repeatedly parsing large identical bootstrap data, catalogs or document models. Effort: very large V8 work. Potential: avoid repeated syntax scanning and conversion without reusing mutable application objects.

Research, 2026-10-31, against `913231d4` and current V8 source. No JSON workloads run. External engine details must be checked against the packaged revision.

## Evidence and distinction

V8's [`JsonParser`](https://raw.githubusercontent.com/v8/v8/main/src/json/json-parser.cc) scans JSON and builds objects, arrays and values. It already uses optimized object construction, shape feedback and fast key paths. A generic faster parser or a claim that every property lookup is uncached would miss that existing work.

The remaining hypothesis is reuse of the complete parse result as a construction recipe when the exact source repeats. [Idea 62](62-native-large-json-responses.md) accelerates individual Node `APIResponse.json()` parses from UTF-8. This proposal avoids repeated parsing inside the application browser. [Idea 98](98-checkpointed-browser-fixtures.md) restores initialized application state; this still executes the application normally and returns new objects on every parse.

Repeated navigation through Flashwright's [context lifecycle](../packages/playwright-core/src/server/browserContext.ts) can repeat application data parsing after responses arrive. The response must still be received normally; a repeated URL is not evidence of identical JSON.

## Proposed change

After a sufficiently large, eligible successful parse, retain a compact immutable recipe: object/array structure, ordered property names, decoded string constants and parsed numeric values. On an exact-content hit, allocate a new graph using the current realm's ordinary object construction machinery.

Lookup occurs inside the native JSON builtin after its required input coercion. Key by exact source content and compatible engine/parse mode. A digest can find candidates but must not authorize a collision to return another result. Retain no application-owned objects or pointers into another isolate's heap.

Start within one isolate and with no callable reviver. A callable reviver follows the ordinary parser before any callback runs. That avoids prematurely handling source-context metadata and arbitrary callback mutations. If later supported, revivers must execute for every call, in the same order, over a fresh graph with the correct source information.

Preserve the semantic distinction between an object's property definition and assignment through a setter. `__proto__`, duplicate keys, integer-like property names and negative zero must produce the same result as normal parsing. Use current-realm shapes; never assume a previously cached V8 map remains valid.

Add cross-renderer recipe sharing only if same-isolate reuse is useful and serialization/remapping is cheaper than parsing. Admission should favor repeated large values; unique payloads should not fill the cache or require expensive recipe generation on every miss.

## Functional boundary

Follow the [ECMAScript JSON.parse contract](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.parse), including coercion, numeric conversion, string code units, fresh identity and property ordering. Invalid input stays on the existing diagnostic path. User replacements for `JSON.parse` still execute normally; this is not a JavaScript monkey patch.

Preserve fetch completion, decoding, service workers, route callbacks and errors. No response replay or early data delivery is involved. Keep an ordinary-parse fallback and a disable switch for cache-sensitive workloads.

## Payoff and later decision

The target is scanning, escape decoding, number conversion and repeated parse bookkeeping. Fresh object allocation and exact-input verification remain linear costs, so this cannot make a large object graph free. Shape-aware V8 parsing may already be fast enough that recipe lookup loses.

Later compare repeated versus unique payloads, numeric versus string-heavy data, cold/warm caches, deep objects and mutation of earlier results. Run JSON language tests and application/evaluation regressions, then the [full matrix/upstream comparison](01-browser-native-actions.md#payoff-and-decision-test). Include retained source/recipe bytes, recipe construction, GC and changed-content misses. Reject wins that come from accidentally returning shared mutable objects.

**Assessed 2026-10-31:** deferred: browser-internal (V8 JSON parser), needs a custom Chromium; only apps parsing large identical bootstrap JSON per document benefit.
