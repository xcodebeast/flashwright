# Generate a fast dispatch path inside Node

**Priority:** high · **Scope:** normal local JavaScript/TypeScript runs · **Effort:** medium to large.

**Status:** not implemented. Related work is done: `81bd7167` and `dd9e31d0` cut other per-call costs (stack capture, errors created ahead of time, expression normalization, GUIDs). Measured per call after them: `page.title` 195 µs, `page.evaluate` 280 µs, `toHaveText` 455 µs, `locator.click` 1535 µs. The dispatch and validation path this idea targets is unchanged.

Research proposal, 2026-10-29. No new benchmarks. This targets the client/server boundary inside Node, independently of the browser-command reduction in [idea 01](01-browser-native-actions.md).

## Remaining cost

[`createInProcessPlaywright`](../packages/playwright-core/src/inprocess.ts) connects client and server within one process and already passes raw Buffers. After initialization, however, it schedules both request and response dispatch through `setImmediate`.

[`ChannelOwner._createChannel`](../packages/playwright-core/src/client/channelOwner.ts) creates channel call wrappers through a Proxy and validates parameters. [`DispatcherConnection.dispatch`](../packages/playwright-core/src/server/dispatchers/dispatcher.ts) looks up the target/method, validates parameters and metadata again, constructs progress/instrumentation scopes and validates the result. [`Connection.dispatch`](../packages/playwright-core/src/client/connection.ts) validates results again and resolves callback records. These are JavaScript object transfers here, **not JSON across a process**; eliminating imaginary JSON overhead would solve the wrong problem.

## Proposed mechanism

Generate paired local adapters from the existing protocol schema. Bind known channel methods to stable functions once, cache validated method/target metadata, and translate channel references directly between the two registries. Validate and canonicalize user values once on entry; keep the ownership/type checks that each side actually needs. Similarly, construct the local result once while preserving its public representation and channel identity.

Use one shared invocation lifecycle for the ordinary and fast paths: API zones, timeout/cancellation, preload interception, active-call tracking, tracing, call logs and disposal checks. Optimizing lifecycle allocation is useful; bypassing that lifecycle is incorrect. Generate adapters into their respective packages so the client/server import boundaries in `DEPS.list` remain intact.

Treat scheduling as a separate experiment. First keep the existing `setImmediate` boundaries and prove that generated adapters save CPU. Next, test a bounded dispatch queue that reduces redundant queue bookkeeping while retaining required asynchronous delivery, FIFO order and fairness. Removing every yield can starve browser events and user timers, or introduce reentrancy bugs.

Remote connections, other language clients, public protocol messages and unrecognized methods retain the normal validated path. Add an internal per-connection disable switch for differential testing and troubleshooting. This should not require a custom browser.

## Functional contract

Malformed inputs must fail with the same public errors. Caller mutations after invocation must not change an in-flight request through accidental object aliasing. Preserve disconnected/collected-object errors, channel ownership, abort races, tracing phase order and callback delivery. Resolve each promise once and retain task ordering visible to user code. The adapter must use the correct worker lane's async context when workers share a process.

## Payoff and decision test

**First experiment:** generate one adapter for a cheap, frequently called method, retaining both asynchronous boundaries. Separately attribute validation, wrapper allocation and dispatch scheduling. Do not extrapolate a browser-free microbenchmark to browser suites without measuring their actual API-call volume.

The opportunity is roughly `API-call count × avoidable local dispatch cost`. It could become substantial for dense assertion/evaluation suites and very short tests, while barely affecting network-bound applications. Fewer wrapper objects, validator copies and callback entries should reduce GC pressure. Current cost shares remain unknown.

When the machine is free, compare cheap getters/evaluations, locator assertions and browser-free APIRequest operations, then apply the [full-suite evaluation rule](01-browser-native-actions.md#payoff-and-decision-test), including the full matrix and old-fork baseline. Run `tests/page` on `chromium-page`, `tests/playwright-test`, channel/connection library tests, tracing/cancellation cases and multi-lane tests against pristine upstream. Reject the scheduling change if timer/event ordering changes; retain only the adapter part if that is the compatible win.
