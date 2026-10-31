# Give shared-process workers separate JavaScript isolates

Scope: parallel suites with CPU-heavy test code, large dependencies or shared-process global conflicts. Effort: very large. Priority: architectural research; compare both existing worker modes.

**Assessed 2026-10-31:** deferred: very large, and `workersPerProcess` already shares processes.

Research, 2026-10-31, against `2bc2768b` plus the live worktree. No workers launched or runtime experiments.

## Evidence and opportunity

The current [`laneRunners`](../packages/playwright/src/common/process.ts) create multiple WorkerMain instances inside one Node runtime. [`workerMain.ts`](../packages/playwright/src/worker/workerMain.ts) routes process-wide events to those lanes. `workersPerProcess` saves memory, but lanes share a JavaScript event loop, globals and module instances. Synchronous work in one lane can delay the others.

[Node worker threads](https://raw.githubusercontent.com/nodejs/node/v22.x/doc/api/worker_threads.md) can execute JavaScript in parallel with separate runtime environments. They are a middle ground between today's same-isolate lanes and separate OS processes. [Idea 33](33-browser-broker-for-isolated-workers.md) shares browsers across processes; this changes the execution unit for test code.

## Proposed change

Add an explicit thread-based worker backend behind the runner's WorkerHost interface. One supervisor process owns a bounded pool of Node Worker threads. Each thread owns one worker identity, module graph, globals, fixture runner, async context and event loop. Keep existing test groups and worker compatibility hashes.

Start with a dedicated browser per thread so automation calls stay local to their owning driver. Do not add a broker hop to every call as part of this experiment. This sacrifices the browser sharing of current lanes; the comparison must include that cost. A later negotiated browser transport could share a browser if it wins independently.

Adapt initialization, ordered messages, stdout/stderr, produced environment, graceful teardown and heartbeat handling to MessagePorts. Keep the supervisor responsive when a test thread blocks. Replace only a failed thread after its owned browser and fixtures are settled; a host-process crash still invalidates every resident worker.

Use existing framework code caches where compatible, but do not claim threads automatically share user module objects or compiled V8 code. Prestarted empty threads can overlap startup without importing user tests early. Never reuse a failed thread's application heap for a replacement worker.

## Compatibility boundary

This needs an explicit execution mode. Worker threads have different process APIs: `process.chdir` is unavailable there, PIDs are shared, and signals/native-addon constraints differ. Keep dedicated processes for unsupported projects. Do not rerun a partially executed test in another backend after discovering incompatibility.

Preserve fresh worker module state, fixture order, retries, timeouts, worker/parallel indices and reporter events within the declared mode. Use separate environment copies rather than `SHARE_ENV`. Native crashes and process-wide resource exhaustion remain shared failure risks; document them and retain process workers as the opt-out.

## Payoff and later decision

The intended gain is parallel JavaScript execution with less process overhead than dedicated workers and stronger JS isolation than current lanes. Dedicated processes already run JavaScript in parallel, so beating lanes alone proves little. Extra isolates, repeated imports and dedicated browsers may consume more memory than current shared lanes.

Later compare all three modes at equal worker counts on CPU-heavy helpers, API suites and ordinary browser workloads, including failures and large imports. Require faster complete runs against the relevant existing mode; memory savings alone must not buy a slowdown. Run worker-index/fixture/retry and `flashwright-workers-per-process` coverage, plus upstream page/runner suites against pristine upstream. Report the full [matrix](../bench/README.md) with mode-specific controls under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No execution now.
