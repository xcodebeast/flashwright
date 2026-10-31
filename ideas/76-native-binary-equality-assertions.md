# Compare binary assertion values with a native byte kernel

Scope: large ArrayBuffer, DataView and typed-array values passed to `toStrictEqual`. Effort: small to medium for a guarded Node implementation. Potential: replace millions of JavaScript byte reads per assertion.

**Assessed 2026-10-31:** deferred: only `toStrictEqual` over large binary values.

Research, 2026-10-31. Source and documentation review only. No assertions or native kernels executed.

## Evidence and difference from existing ideas

[`expectLibrary.ts`](../packages/playwright/src/matchers/expectLibrary.ts) includes Jest's `arrayBufferEquality` in `toStrictEqualTesters`. The installed `@jest/expect-utils/build/index.js` turns supported buffers/views into DataViews, checks lengths, then compares every byte through two `getUint8` calls. [Jest's source](https://github.com/jestjs/jest/blob/main/packages/expect-utils/src/utils.ts) exposes the same helper; the installed version is the implementation baseline.

This is already a byte comparison. Its cost is the JavaScript loop, not an absent equality algorithm. Node offers [Buffer equality and shared-memory Buffer views](https://raw.githubusercontent.com/nodejs/node/v22.x/doc/api/buffer.md), allowing a native comparison without copying the full inputs.

[Idea 25](25-indexed-collection-assertions.md) indexes collection membership. This replaces the binary leaf comparator. It does not alter screenshot pixel tolerances or [idea 04](04-raw-screenshot-comparison.md).

## Proposed change

Replace only the built-in byte-comparison loop for eligible values. After preserving the current classification, constructor checks and view boundaries, create Buffer views over the exact backing-store ranges and call the native equality implementation. Keep the original helper for small inputs if wrapper creation costs more than it saves.

Install the helper at its existing position in the tester list. User equality testers must run first and may return a result or mutate the operands. Do not bypass them with a top-level matcher shortcut.

Use a new adapter file and a small marked import change. Do not patch `node_modules` as the implementation. This first stage needs no browser fork, custom Node build or additional native package.

## Compatibility boundary

Limit the first version to ordinary, fixed-size, non-shared backing stores and unmodified built-in accessors/methods. SharedArrayBuffer can change while it is read; native wide reads need not reproduce a byte loop's observations. Resizable, detached, cross-realm or customized values retain the old path until equivalence is established.

DataView subclasses and overrides of `getUint8`, `buffer`, `byteOffset` or `byteLength` are especially sensitive. Eligibility checks must not themselves add getter or Proxy side effects. Use native brand/proxy checks and conservative descriptor guards where possible; otherwise fall back before touching user-visible state.

Preserve the helper's existing raw-byte semantics for floating-point views, including NaN payloads and signed zero. Do not substitute numeric element equality. Conversely, do not apply this fast path to `toEqual`: that matcher uses a different tester list and can inspect typed-array properties differently.

Keep failure formatting, custom matchers, negation and errors unchanged. A faster passing comparator does not justify truncating a failing binary diff.

## Payoff and later decision

Matching large buffers and late mismatches are the strongest cases. Early mismatches and tiny views may favor the current loop. Byte scanning remains O(N), but runs in the native kernel with constant-size wrappers and no full input copies.

Later compare full assertions over lengths, offsets, subviews and mismatch positions, plus customized values that must fall back. Include repeated nested binary fields and one/four workers. Measure CPU and complete test time; report mismatch-formatting costs separately.

Run built-in/custom matcher coverage and the [full matrix and upstream comparison procedure](01-browser-native-actions.md#payoff-and-decision-test), adding binary-assertion rows and current-fork controls. Defer execution.
