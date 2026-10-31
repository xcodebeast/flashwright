# Parse large response bodies directly from UTF-8 into JavaScript values

Scope: API and browser-response assertions over large JSON datasets. Effort: very large for exact JavaScript semantics and efficient V8 object construction. Priority: exploratory, with a useful ceiling only if the complete adapter beats V8's existing parser.

**Assessed 2026-10-31:** deferred: only large JSON responses; V8's own `JSON.parse` is the baseline to beat.

Research, 2026-10-31, against `95f3e831` and the live worktree. No response bodies parsed or native prototypes run.

## Evidence and distinct opportunity

Both [`APIResponse.json`](../packages/playwright-core/src/client/fetch.ts) and [`Response.json`](../packages/playwright-core/src/client/network.ts) call `text()`, which converts the body Buffer to a JavaScript string, then call `JSON.parse`. Large payloads therefore require the body, an intermediate string and the resulting object graph. ASCII strings need not occupy two bytes per character; no fixed 2× string-memory claim is justified.

[simdjson](https://github.com/simdjson/simdjson) demonstrates vectorized UTF-8 parsing and native representations. V8's `JSON.parse` is itself highly optimized native code. A fast C++ parse benchmark does not include creating ordinary JavaScript objects, so simply binding simdjson is not evidence of a Flashwright win.

[Idea 24](24-packed-evaluation-values.md) changes evaluation serialization, [idea 25](25-indexed-collection-assertions.md) changes equality checks, and [idea 16](16-segmented-api-request-bodies.md) changes byte ownership. This targets the explicit JSON decoding operation between response retrieval and those assertions.

## Proposed change

Build a narrow adapter for large response Buffers. Scan UTF-8 bytes into compact structural records, then construct the final JavaScript values once in the caller's isolate. Avoid a full intermediate JavaScript string and avoid a second generic native DOM that must later be recursively copied. Retain the existing parser below a measured size threshold.

Evaluate two implementations: a SIMD parser with a compact token representation and a V8-integrated UTF-8 entry point that retains V8's object-building optimizations. The latter requires maintaining a custom runtime or upstreaming engine work, but may avoid per-property native-addon call overhead. Keep this an optional backend until it wins complete response operations.

Start synchronously after body acquisition, preserving the current execution checkpoints. Background scanning is a later, separately measured mode: it adds buffer ownership, scheduling and materialization costs. Do not return lazy proxy objects or defer syntax errors until properties are read. The caller must receive the complete ordinary value before `json()` resolves.

## Compatibility boundary

Match [ECMAScript JSON.parse semantics](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.parse), including duplicate keys, numeric rounding/overflow, negative zero, escaped lone surrogates, property order and `__proto__` as a normal data property. UTF-8 decoding must also match `Buffer.toString('utf8')`, including replacement behavior for malformed input. A stricter native parser cannot silently reject a body the current pipeline accepts.

For invalid or unsupported input, call the original decoder/parser on the same captured bytes to preserve runtime-specific errors. Native parsing has no user callbacks, so that fallback need not repeat application effects. Custom or overridden `text`, `body`, Buffer decoding or `JSON.parse` behavior must retain the current path; bypassing those calls would change observable code.

Every `json()` call still returns a fresh graph. Do not cache a mutable result or alias strings to externally mutable Buffer storage. Preserve disposal races, body-fetch errors and wrapper instrumentation. Bound native scratch allocations, and fall back safely on unsupported runtimes without requiring a native dependency for ordinary runs.

## Payoff and later decision

The target is intermediate string allocation, UTF-8 scanning and parse CPU. Object allocation remains and can dominate. Native-addon boundaries, duplicate token storage or input copying may make the proposal slower and larger than V8; that result should end the attempt, not justify changing returned values.

Later compare complete `response.json()` plus representative property access on arrays, wide objects, escaped/non-ASCII strings, numeric extremes and malformed inputs. Include repeated calls, Buffer mutation and overridden methods. Measure wall time, peak RSS and GC for actual supported Node versions, with one/four workers and shared-process lanes.

Run APIRequest/browser-response/evaluation coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report a large-JSON corpus beside the full [matrix](../bench/README.md), with current-fork controls under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No experiments now.
