# Restore initialized application backends for each test

**Scope:** tests repeatedly booting, migrating or seeding substantial local application stacks. **Effort:** monumental for a general solution. **Priority:** exploratory, with a potentially much larger ceiling than framework micro-optimizations.

Research proposal, 2026-10-31. No VM, server or experiment started. This snapshots an explicitly declared application environment, not the [framework-only Node heap](09-preinitialized-node-runtime.md), browser storage generations or an already-running browser renderer.

## Evidence

[`FixtureRunner`](../packages/playwright/src/worker/fixtureRunner.ts) runs user setup and teardown for the requested scope. Compiling its dependency plan cannot remove application initialization inside those functions. [`WebServerPlugin`](../packages/playwright/src/plugins/webServerPlugin.ts) launches commands and waits for readiness; it does not provide a fresh, initialized backend image per test.

[Firecracker snapshotting](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md) can restore guest memory and machine state. Disk backing files and host network resources require separate management, and open connections are not guaranteed to survive. This is a possible mechanism, not evidence that restoring a web stack is faster than its existing reset fixture.

## Proposed change

Introduce an explicit checkpointable-backend fixture contract. A preparation phase boots a guest containing the app, database and other owned state, runs migrations/seeding, then reaches an application-provided quiescence barrier. Capture a consistent memory image and matching disk state once.

For each test attempt, create private copy-on-write memory/disk branches, restore the guest, run declared restore hooks, and publish its endpoint only when ready. Give the test a normal fresh browser context and connect to the restored backend. Dispose the entire branch at teardown, including on failure; never merge test writes back into the template.

Start with backend-only snapshots. Keeping browser, Node test worker and test execution outside the image avoids cloning their protocol sessions, pending promises and renderer state. A whole-browser checkpoint is a separate research problem already adjacent to historical renderer-fork work.

Key the image by application code, dependencies, schema, seed inputs, configuration and compatible VM/runtime identity. Warm only the working set needed to reach readiness; eager restoration of gigabytes can be slower than startup. Limit retained templates and concurrent dirty branches.

## Compatibility

The fixture author must declare that setup effects belong inside the snapshot and specify restore hooks. Arbitrary external email, payments, remote databases or shared queues cannot be rolled back by cloning local memory. Exclude them or supply an explicitly isolated service, never silently replay a successful setup result.

Fresh randomness, application IDs, clocks, credentials and connection pools need restore treatment before accepting traffic. Kernel reseeding does not reset every application RNG or cached token, as [Firecracker's clone guidance](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/random-for-clones.md) explains. Old timers must follow a declared clock policy; expired authentication must not become valid through a rewind. Reject unsupported stacks before running tests.

This is an opt-in environment contract, not a drop-in replacement for arbitrary beforeEach code. Document setup execution frequency, restored state and clock behavior in README. Ordinary fixture setup is the opt-out. Preserve per-attempt isolation, retry accounting, readiness failure and teardown errors within that contract.

## Payoff and later decision

Compare `prepare once + N × (restore + rebind + dispose)` with N ordinary setup/reset cycles. The benefit requires expensive repeated preparation and a much cheaper restore. Cheap database transactions, container reuse or file snapshots may beat a VM and should be the first alternatives. Page faults, dirty memory, disk branches and preparation all count.

Later use a controlled app/database stack and compare every initial state plus deliberate writes across attempts. Test interrupted restore, changed source, unique identifiers, expiration and complete branch cleanup. Run fixture/retry coverage, `tests/playwright-test` and `tests/page` on `chromium-page` against pristine upstream in `workbench/pw-src` in ordinary mode, plus a dedicated contract corpus.

Report this mode separately beside the unchanged `node bench/matrix.mjs` and scenario command, with current-fork ordinary-fixture and simpler-reset controls under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Build and execute on separate capacity when available.
