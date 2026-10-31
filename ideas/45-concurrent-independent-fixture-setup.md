# Overlap fixture setup when fixture authors declare it independent

Scope: suites with several expensive asynchronous fixtures per test or worker. Effort: large. Priority: high potential for setup-bound suites; explicit opt-in.

Research, 2026-10-31, against `c4c3583b` and the live worktree. No fixtures or services were executed.

## Where the work is

[`FixtureRunner.resolveParametersForFunction`](../packages/playwright/src/worker/fixtureRunner.ts) builds a dependency order, then awaits each fixture setup in one loop. Two independent fixtures that each spend a second provisioning a resource consume about two seconds before the test starts. Their dependency graph alone does not authorize concurrent side effects.

[Idea 11](11-compiled-fixture-plans.md) explicitly preserves that execution order while caching graph planning. This proposal changes the scheduling of user setup under a new declaration. It is also separate from launching configured web servers or scheduling whole tests.

## Proposed change

Let fixture authors opt named fixtures into a concurrent setup group and declare any shared exclusive resources. Only members of that group whose dependencies have reached `use(value)` may start together. Undeclared fixtures and existing automatic-fixture/hook boundaries retain their present order.

A registration needs one shared setup promise, not merely an entry in `instanceForId`. Today's `Fixture.setup` registers the instance before its value is ready. A concurrent dependent must await readiness and receive the same failure; it cannot interpret instance existence as successful setup.

Replace the single-active-runnable assumption for this mode. [`TimeoutManager.withRunnable`](../packages/playwright/src/worker/timeoutManager.ts) currently rejects a second active runnable. Give concurrent setups individual deadline records beneath one test/worker wall-clock budget. Charge overlapping elapsed time once to the shared budget, while preserving each explicit fixture timeout. Keep step ownership and async context distinct.

Start with concurrent setup only. Record a stable topological teardown order and run teardown sequentially, after all started setups settle or are safely terminated. Parallel teardown is a separate contract, not a free consequence of parallel setup.

## Compatibility boundary

The [fixture execution contract](https://playwright.dev/docs/test-fixtures#execution-order) requires dependencies to be ready before consumers and to outlive them. Preserve scopes, lazy activation, overrides, `use()` semantics and hook boundaries. Never run an unused fixture just because there is spare capacity.

Concurrent setup changes log order and external side-effect order. Require explicit declarations, document them in README, and retain ordinary setup as the opt-out. Fixtures sharing process globals, a database namespace or the same page must either declare an ordering dependency/exclusion or remain sequential.

If one setup fails, stop admitting new work, retain every started fixture for cleanup, and aggregate errors in a stable declared order. Arbitrary JavaScript cannot be forcibly canceled by rejecting a promise. Keep the worker occupied until outstanding setup has settled or the existing worker termination mechanism has fenced it. A timed-out provisioner must not leak resources into the next test.

## Payoff and first decision

For independent setup durations a and b, the ideal critical path moves from `a + b` toward `max(a, b)`. This can save seconds without changing worker count. CPU-heavy fixtures or a saturated backend may lose; use a small concurrency cap and resource exclusions. The mechanism mainly overlaps work rather than reducing total CPU.

The first later prototype should support two explicitly grouped I/O fixtures and one dependent, including one failing before `use()` and one finishing late. Compare lifecycle events, timeout accounting and cleanup before measuring speed.

Run fixture, timeout, hook, retry and worker-error coverage in `tests/playwright-test`, plus `tests/page` on `chromium-page`, against pristine upstream in `workbench/pw-src`. Report opt-in fixture workloads separately alongside the full `node bench/matrix.mjs`, the [scenario command](../bench/README.md) and current-fork controls under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No execution now.
