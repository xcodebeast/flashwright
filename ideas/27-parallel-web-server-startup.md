# Start independent web services along a declared dependency graph

**Scope:** suites launching several frontend/backend services through webServer. **Effort:** medium to large. **Priority:** high potential for multi-service cold runs; no benefit for one service.

Research proposal, 2026-10-29. No measurements. This is an explicit orchestration extension, independent of [test-worker scheduling](08-contention-aware-scheduling.md). It does not reuse an old application server or alter application time.

## Evidence

[`webServerPluginsForConfig`](../packages/playwright/src/plugins/webServerPlugin.ts) produces one plugin per server. [`createPluginSetupTasks`](../packages/playwright/src/runner/tasks.ts) converts plugins to tasks, and [`TaskRunner`](../packages/playwright/src/runner/taskRunner.ts) awaits each setup in order. A server's setup includes waiting for readiness, so later independent servers cannot begin while the first initializes.

The fork already shortened readiness polling to 20/50/50 ms and then 100 ms. Existing stdout/stderr regex readiness is also implemented. Proposing either as a missing feature would be redundant; the larger remaining delay is serialized service startup.

## Design

Introduce optional server identifiers and `dependsOn` relationships. Leave existing configuration sequential. An explicitly independent service can start alongside others; dependent commands begin only after their prerequisites satisfy the existing readiness condition. Validate missing names and cycles before launching anything.

Run only the webServer subgraph concurrently. Arbitrary plugins, global setup and test discovery retain their established ordering. Use bounded startup concurrency, configurable for machines where simultaneous bundlers would compete for CPU/memory. Dependency-free does not mean unlimited launch concurrency.

Track each process immediately after launch so cancellation can clean up every started service, including those still waiting for readiness. Teardown follows reverse dependency order; independent services may terminate together where their declared contract permits it. Preserve each server's timeout and an overall run deadline.

Named captures from readiness output currently write environment variables. Treat those as dependency outputs: a consumer starts with the completed prerequisite environment. Concurrent writers of the same output name need an explicit conflict rule, preferably rejection before launch where knowable. Never silently race shared `process.env` mutations.

## Compatibility and payoff

Concurrency changes observable launch/log order and when servers contact shared systems. Require explicit configuration, document the difference in README before release, and retain sequential mode as the opt-out. Existing projects remain unchanged; do not advertise this mode's gains as automatic drop-in acceleration.

Preserve reuseExistingServer, readiness OR behavior between configured mechanisms, URL/port checks, prefixes, early-exit errors, signals and cleanup on partial failure. Tests must not start until all required servers are ready. An unrelated server failing while another succeeds must still fail setup and clean up both.

For independent services with startup durations `a`, `b` and `c`, the ideal setup bound changes from their sum toward their maximum. Real contention and dependency edges increase that bound. This can remove seconds from short suites without skipping tests; on a saturated machine, concurrent builds can be slower and consume more memory.

## Later decision test

Use independent services plus chains/diamonds, dynamic port outputs, readiness races, reused servers, startup failures and cancellation. Verify complete process-tree cleanup. Compare full launch-to-exit duration and peak resources with several concurrency limits; include teardown.

Later run [`web-server.spec.ts`](../tests/playwright-test/web-server.spec.ts), plugin/global-setup coverage, `tests/playwright-test` and `tests/page` on `chromium-page` against pristine upstream in `workbench/pw-src`. Report opt-in multi-service rows separately beside `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and `node bench/matrix.mjs`, with a current-fork baseline under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Do not launch services now.
