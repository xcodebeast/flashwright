# Construct only the assertion matcher that a test uses

Scope: assertion-heavy browser and API suites. Effort: medium. Priority: a strong first prototype without a browser change.

**Assessed 2026-10-31:** rejected. Building the matchers measured 4.2 ms per TodoMVC run, about 12 µs per `expect()` (under 0.5%).

Research, 2026-10-31, against `c4c3583b` and the live worktree. Source inspection only; no measured speedup.

## Where the work is

[`createMatchers`](../packages/playwright/src/matchers/expect.ts) merges the built-in and user matcher registries on every `expect(value)`. For each matcher it creates six closures: ordinary, negated, resolves, resolves-negated, rejects and rejects-negated. A normal `expect(value).toBe(expected)` uses one of them. The closures capture the received value and assertion settings, then become garbage.

With A assertions and M registered matchers, construction creates roughly `6 × A × M` wrappers. Equality, browser calls and reporting happen afterwards. [Idea 25](25-indexed-collection-assertions.md) speeds up comparisons; [idea 26](26-compact-worker-step-events.md) changes step transport. Neither removes this front-end allocation multiplier.

## Proposed change

Keep a versioned, immutable matcher registry for each effective expect configuration. Each assertion holds only its received value, settings and a reference to that registry. Materialize a bound matcher closure when its property is first read; cache that closure on the assertion object. Create `.not`, `.resolves` and `.rejects` views only when needed.

A Proxy can preserve the existing property surface while making common property access cheap. It is a candidate implementation, not an automatic performance win. Prototype it against a generated dispatch table and the current eager implementation before choosing a representation.

Reflection must materialize the appropriate ordinary data properties. `Object.keys`, property descriptors, assignment, deletion, spreading, freezing and preventing extensions cannot expose a different object shape merely to save allocations. The [ECMAScript Proxy invariants](https://tc39.es/ecma262/2024/multipage/ordinary-and-exotic-objects-behaviours.html#sec-proxy-object-internal-methods-and-internal-slots) constrain this design. A complex reflection path may reasonably cost as much as today's eager construction.

Preserve the registry snapshot visible when `expect(value)` was called. An `expect.extend()` performed later must not change an already-created assertion. Invalidate shared registry metadata when extensions change the effective matcher set, including the existing distinction between legacy extension mutation and overriding built-ins on the returned expect instance.

## Compatibility boundary

Detached matcher functions must still work, repeated reads must return the same function, and later property replacement/deletion must take precedence. Keep matcher names, missing properties, promise handling, custom matcher context, soft assertions, stacks and steps unchanged. Do not move matcher execution or stack capture to property access.

Do not share mutable assertion state or received values across calls or worker lanes. Retaining an extracted matcher can legitimately retain its original value; global registry caches must not retain completed assertions. Keep the eager constructor as the internal fallback.

## Payoff and first decision

The target is construction proportional to the matcher views actually used, with much less temporary allocation. This could be substantial in generated/API suites with thousands of cheap assertions. Browser-bound tests may see little change; this is not a claim that matcher construction dominates TodoMVC.

When capacity is free, first compare construction, complete assertions and GC with small/large custom registries, including reflection-heavy callers. Reject a Proxy whose lookup cost erases its allocation savings. Compare exact behavior through expect extension/configuration, built-in, promise, soft and poll tests.

Then run `tests/playwright-test` and `tests/page` on `chromium-page`, comparing failures and flakes with pristine upstream in `workbench/pw-src`. Report current-fork/candidate results and the complete `node bench/matrix.mjs`, plus `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and an assertion-dense workload. Follow the [shared evaluation rules](01-browser-native-actions.md#payoff-and-decision-test); no tests or benchmarks were run for this note.
