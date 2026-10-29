# Compile fixture dependency plans once

**Scope:** large suites with many short tests and fixture-heavy hooks. **Effort:** medium. **Priority:** promising low-risk first prototype.

Research proposal, 2026-10-29; source inspected at `1aebba9e` plus the current worktree. No experiments or new speed claims.

## Evidence and opportunity

[`FixtureRunner.resolveParametersForFunction`](../packages/playwright/src/worker/fixtureRunner.ts) collects and sorts automatic fixtures, walks dependencies into a new Set, resolves registrations, and builds parameters for each runnable. Teardown reconstructs an order from live instances and their usage sets. [`FixturePool`](../packages/playwright/src/common/fixtures.ts) already validates dependencies, and `fixtureParameterNames` already caches parsed function signatures. Caching signatures again would accomplish little.

The remaining opportunity is to compile the **dependency plan**, then instantiate its mutable state cheaply. This is different from [fixture-aware scheduling](08-contention-aware-scheduling.md): placement and fixture lifetimes stay unchanged.

## Design

Cache an immutable plan by actual pool identity, function identity and automatic-fixture mode. Record the current ordered setup list, dependency registration references, parameter names and teardown edges. Store the automatic-fixture order once per pool. Start with arrays of registrations; generated JavaScript is unnecessary unless later evidence justifies it.

Execute that plan through the existing setup/timeout/step machinery. Skip already-live worker fixtures exactly as today. Retain per-instance values, failures, promises and dependency usages; no test receives a prior test's fixture value. A later optimization can replace repeated maps/sets with indexed per-attempt slots, but only where partial setup and teardown produce identical behavior.

Do not key solely by `pool.digest`: its worker-compatibility purpose does not establish identical test-scoped registrations. Overrides, `super` dependencies, `test.use()` and automatic-fixture modes must select distinct plans. Weakly owned caches should disappear when their pools/functions are no longer reachable.

## Compatibility boundary

Independent dependency branches are not permission to run user fixtures concurrently. Their setup order, side effects, `use()` handoff, teardown order, hooks, timeout slots, error precedence and reporter steps are observable. Preserve them. Compile the plan only after the existing validation has produced its normal errors.

A fixture that throws before `use()`, times out during teardown or is shared by multiple consumers must clean up the same successfully initialized instances. Existing worker-process and shared-lane isolation remain intact. Keep the current interpreter available behind an internal troubleshooting switch; this proposal intends no observation differences.

## Payoff and later validation

Savings scale with runnable count times repeated graph-planning work. A suite with thousands of small tests may spend a meaningful fraction here; an expensive database fixture will not become cheaper. Fewer temporary Sets, arrays and lookups can reduce GC without creating another background process.

First prototype only cached setup order. Compare complete fixture/step event sequences with the interpreter on overrides, auto fixtures, diamond dependencies, retries and partial failures; then measure framework CPU and end-to-end time. Drop later slot/code-generation work if graph planning is insignificant.

When the machine is free, add a many-short-tests fixture workload, compare current fork versus candidate, and run `node bench/run.mjs todomvc 1 15 stock,fork` plus `node bench/matrix.mjs 15`. Run `tests/playwright-test`, especially fixture/hook/timeout/retry coverage, and `tests/page` on `chromium-page`; compare failures and flake rates with pristine upstream in `workbench/pw-src`. Count plan construction and retained memory. Follow the [shared measurement rules](01-browser-native-actions.md#payoff-and-decision-test), with small `Flashwright:` hooks and new machinery in new files.
