# Transfer evaluation values without expanding them into wrapper trees

**Scope:** large evaluate/evaluateAll results, bindings and structured test data. **Effort:** medium for allocation fixes, very large for a browser-native codec. **Priority:** high for data-heavy automation.

Research proposal, 2026-10-29. No measurements. [Binary browser transport](15-binary-browser-protocol.md) changes CDP's envelope; this changes the value representation produced before the envelope exists. Either can be evaluated independently.

## Evidence

[`utilityScriptSerializers.ts`](../packages/isomorphic/utilityScriptSerializers.ts) walks browser values and expands arrays/objects into tagged structures, tracking reference IDs. Object properties become `{ k, v }` records. Typed arrays use base64; when native `toBase64` is unavailable, the fallback creates per-byte arrays/strings. The native fast path already exists and must not be credited as new.

On the Node side, [`serializers.ts`](../packages/protocol/src/serializers.ts) also constructs tagged trees and copies the diagnostic `accessChain` array at every recursive child. A deep chain can therefore create quadratic total path-copy work even though the graph itself has only linear size. Large results then undergo additional protocol serialization and reconstruction.

## Design

First remove unnecessary path copies using a stack or parent-linked diagnostic path, formatting it only on error. Preserve traversal, getter access and error location. This is independently useful without a new wire format.

The larger design is a compact, versioned value stream: scalar tags, reference IDs, lengths, property names and binary segments. Write directly during the existing semantic traversal, avoiding an intermediate object per property. Decode into the public JS result once. A Chromium integration could encode on the renderer side and carry binary segments outside ordinary CDP JSON; stock engines retain the current format.

[V8's ValueSerializer](https://chromium.googlesource.com/v8/v8/+/060f05787c86bfa267be08ada18b58dbac4cac3b/include/v8-value-serializer.h) is a native structured-clone primitive worth investigating, but its semantics are not Playwright's serializer contract. Do not substitute it wholesale. Prefer a narrow Playwright-compatible encoder or a proven eligible subset, with explicit protocol version negotiation.

## Compatibility and payoff

Preserve cycles, repeated references, special numbers, BigInt, typed-array subviews, handle ownership and current treatment of symbols, functions, DOM values, Maps/Sets and toJSON. Argument and result serializers are not interchangeable. Getters, proxies and thrown property accesses make a speculative first traversal followed by fallback unsafe: user code might run twice. Choose the codec before traversal, or ensure one traversal captures everything necessary for either output.

Do not detach user buffers to obtain a zero-copy claim. Shared memory needs immutable ownership and a lifetime protocol; otherwise copy once. Debugging, mixed client versions and unsupported engines need the original path.

Savings are wrapper allocations, repeated graph traversal and binary expansion. Small scalar calls should remain cheap; native boundary overhead can exceed their serialization cost. The asymptotic path-copy fix is a good first probe, while the full codec matters most for megabyte-scale results.

## Later decision test

Compare exact values, alias relationships, errors and getter/proxy invocation sequences against both existing serializers. Include deep graphs, wide arrays, binary subviews, navigation/cancellation and mixed-version peers. Measure whole calls, CPU, peak RSS and transfer bytes.

Later run evaluation/binding/handle library tests, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report `node bench/run.mjs <scenario> <workers> <iterations> stock,fork`, the full `node bench/matrix.mjs`, large-value cases and a current-fork baseline under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No benchmarks now.
