# Keep API call stacks structured from capture to reporting

Scope: command-dense browser tests, many small assertions and deep TypeScript helper stacks. Effort: medium to large; a runtime extension is optional. Priority: broad but with a modest ceiling on ordinary browser suites.

**Assessed 2026-10-31:** deferred: capturing and filtering call stacks costs about 1 ms per TodoMVC test in the worker.

Research, 2026-10-31, against `2bc2768b` plus the live worktree. No stack-capture benchmark or runtime changes.

## Evidence and opportunity

[`captureFromCallSites`](../packages/playwright-core/src/client/clientStackTrace.ts) already avoids formatting discarded framework frames. It still formats the kept CallSites into strings, splits those strings and parses them back into `StackFrame` records. [`installSourceMapSupport`](../packages/playwright/src/transform/compilationCache.ts) caches mapped strings, not final structured locations.

This is remaining work after the fork's lazy/selective formatting improvements. [Idea 03](03-generated-in-process-dispatch.md) changes protocol adapters and cites earlier stack-cost measurements; those measurements constrain expectations here but are not new candidate results.

## Proposed change

Add a structured source-map adapter beside the existing text formatter. Capture the ordinary V8 CallSites once, identify the API boundary, map only retained frames, and construct final `StackFrame` records directly. Cache immutable mapped positions by compiled-source-map identity, generated position and the naming inputs needed for exact output. Format strings only for actual error text or a consumer that asks for them.

Keep the original CallSite capture first. That retains V8's existing async-stack behavior while isolating the gain from removing format/parse cycles. Preserve public object ownership by copying cached records when a consumer can mutate them.

As a second stage, assess `util.getCallSites()` on supported Node releases. [Node's implementation](https://raw.githubusercontent.com/nodejs/node/v22.x/src/node_util.cc) obtains structured frames through V8's `CurrentStackTrace`; it is a candidate capture primitive, not a drop-in equivalent to Error stacks. Async parents, method names and custom formatters may differ. Do not silently use it where required frames would disappear. If full parity needs a narrow V8/Node adapter, compare that maintenance cost with the measured remaining capture cost first.

## Compatibility boundary

Preserve source-mapped file/line/column, function naming, API names, async frames, boxed steps and complete failure stacks. Source-map-support may derive a display name differently from `getFunctionName()`; direct getters alone are insufficient.

Custom `Error.prepareStackTrace`, unusual eval/native frames, debugger modes and unsupported runtimes retain the current formatter when necessary. Preserve hook invocations where callers can observe them. Do not globally reduce stack depth, recapture only after failure, or replace a full caller chain with its top location.

## Payoff and later decision

Savings scale with captured calls and retained frame depth. This can matter in generated suites issuing thousands of cheap operations, but it cannot eliminate browser work or the stack walk itself in the first stage. Existing mapped-frame caches already remove repeated mapping, limiting the remaining gain. Fewer transient strings are a plausible CPU/allocation benefit, not an established suite speedup.

Later compare structured records and final rendered errors exactly across TypeScript/ESM, nested helpers, async/Promise.all, custom stack hooks and source-map changes. Use source-location, step and error-formatting runner coverage, then upstream page/runner suites against pristine upstream. Report the entire [matrix](../bench/README.md) plus a call-dense workload and current-fork controls under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Size the gain before adopting a custom runtime; no experiments now.
