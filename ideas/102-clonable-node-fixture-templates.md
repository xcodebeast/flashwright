# Clone prepared Node fixture heaps into isolated workers

Scope: expensive in-process fixture preparation, large lookup structures and many worker replacements. Effort: monumental, likely requiring a dedicated Node/V8 runtime. Compatibility: explicit checkpointable fixtures; ordinary fixtures remain unchanged.

**Assessed 2026-10-31:** deferred: needs a dedicated Node/V8 runtime.

Research, 2026-10-31, against `1f613889` and public runtime documentation. No processes forked or snapshots built for this research.

## Evidence and distinction

[`ProcessHost`](../packages/playwright/src/runner/processHost.ts) starts workers through `child_process.fork`. Despite its name, [Node documents that this launches a new process without cloning the parent's heap](https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html#child_processforkmodulepath-args-options). [`WorkerMain`](../packages/playwright/src/worker/workerMain.ts) loads test files and [`FixtureRunner`](../packages/playwright/src/worker/fixtureRunner.ts) prepares each worker's fixture instances.

Warm standby processes and compilation caches do not inherently reuse the result of expensive user fixture computation. Sharing one worker fixture helps tests within that worker but repeats preparation across workers and replacements.

[Idea 09](09-preinitialized-node-runtime.md) snapshots installation-owned framework state and excludes user modules. [Idea 39](39-checkpointed-application-backends.md) snapshots a separate service. This proposal prepares declared user fixture heaps once, then gives separate Node processes independent copies. [Idea 69](69-worker-thread-execution-lanes.md) changes isolation infrastructure without eliminating that preparation.

## Design

Define a checkpointable fixture with three phases: prepare a pure template, attach per-worker resources, and dispose that worker's attachment. The template might contain a costly schema compiler, parsed corpus or large object index. Preparation must not depend on worker identity or produce per-worker external effects.

A template process initializes only approved modules and fixture data, reaches a runtime-owned safepoint, and becomes immutable. Workers branch from its heap using copy-on-write pages or a custom heap image. After branching, create fresh IPC, async context, worker identity, RNG state and fixture ownership. Run ordinary test-module collection and hooks in the child unless separately declared part of the template contract.

Start with pure JavaScript state and no active handles or native addons. A smaller serializable-data cache is the comparison: rebuilding an object graph from a data file may already be cheap enough. Full heap cloning earns its complexity only when expensive initialized functions/graphs or large shared pages materially improve the result.

## Functional boundary

Do not call raw POSIX fork from an arbitrary running Node process. V8 background threads, allocator locks, libuv loops, native libraries and GC roots all need a supported checkpoint protocol. [`uv_loop_fork`](https://docs.libuv.org/en/stable/loop.html#c.uv_loop_fork) repairs some loop state; it does not certify Node or V8 as safely clonable.

Never duplicate browser connections, file offsets, sockets, timers, database transactions or cleanup ownership. Reject unsupported state before exposing a worker. Each worker must mutate its own heap, and a failed worker must never contaminate the template used for retries.

Preparation frequency changes by explicit contract. Report preparation/attachment failures truthfully rather than synthesizing normal fixture execution events. Keep unmodified fixtures on the existing path, with a documented opt-out and README differences if shipped. Template identity includes module bytes, declared inputs, configuration, runtime and architecture.

## Payoff and later decision

The ceiling is repeated user initialization, potentially much larger than framework startup. Copy-on-write can also reduce aggregate memory until workers mutate most pages. Snapshot creation, page faults, reattachment and template retention all count; summing RSS alone overcounts shared pages.

Later compare ordinary worker fixtures, serialized-data restoration and heap branching on cold starts and failure-heavy runs. Check isolation, teardown, retries, timeouts and process termination. Run `tests/playwright-test`, `tests/page` on `chromium-page`, runtime-specific regressions and the [complete matrix/current-fork comparison](01-browser-native-actions.md#payoff-and-decision-test) against pristine upstream. No runtime experiments while the host is occupied.
