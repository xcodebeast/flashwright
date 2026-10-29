# Start runners from a preinitialized framework snapshot

**Priority:** exploratory, strongest for cold/short runs · **Scope:** CLI/worker initialization and failure restarts · **Effort:** very large for reliable packaging.

Research proposal, 2026-10-29. No new benchmarks. This preserves fresh runner/worker processes; it does not extend application-global reuse.

## Remaining cost

[`codeCache.ts`](../packages/playwright/src/codeCache.ts) already caches compiled framework bundles after representative execution. It still executes each bundle's top-level initialization in every process, building classes, protocol tables, closures and registries. [`ProcessHost._startProcess`](../packages/playwright/src/runner/processHost.ts) adopts a standby or creates a fresh process; the warm session also prepares future processes. These overlap startup but still pay its CPU/memory cost, and cold CI runs or immediate failure restarts may expose it on the critical path.

Node supports [startup snapshots](https://nodejs.org/download/release/v22.12.0/docs/api/cli.html#--build-snapshot): a heap initialized from a bundled entrypoint can be serialized and restored. The cited Node 22 documentation imposes bundling and built-in-module limitations. This is a primitive to investigate, not evidence that Playwright can be snapshotted unchanged.

## Proposed mechanism

Separate framework initialization into two phases. The snapshot phase creates only serializable, installation-owned code and data: protocol definitions, validators, class definitions and immutable tables. The restore phase creates everything tied to this invocation: timers, async contexts, process IPC, file/network handles, browser connections, loggers, environment-sensitive settings and mutable registries.

Produce separate runner/worker/CLI snapshot entrypoints only if their initialization profiles justify it. Prefer an optional runtime-specific snapshot cache over requiring every user to change Node. The launcher detects the exact compatible runtime and uses the blob; unsupported combinations take the current code-cache path. A bundled custom runtime is a later option if ordinary Node launch restrictions make delivery impractical.

The compatibility key must cover Node/V8 version, platform/architecture, relevant runtime flags, framework bundle content and installation identity where paths are captured. Build/install snapshot generation has a real cost: do not hide it when evaluating one-shot CI. Never make an ordinary test invocation launch a heavy snapshot build unexpectedly.

## Functional contract

No user config, test, fixture, reporter plugin or application dependency may execute during snapshot creation. They must load fresh after restoration with current `cwd`, environment and module resolution. Native handles, RNG state, timestamps, terminal state and process identifiers cannot be inherited as if current. Framework singletons that capture environment or install hooks at import time must be refactored or excluded.

Preserve ESM/CJS behavior, source maps, stack locations, coverage/debugger modes, signal handling and worker failure isolation. Do not fork a live multithreaded Node/browser process. Existing [archived renderer-fork findings](../workbench/architecture-evidence-inventory-001/report.md) are a separate mechanism and provide no correctness or speed evidence for this proposal.

## Payoff and decision test

**First experiment:** snapshot a framework-only protocol/validator bundle with one pinned supported Node binary. Compare restore-plus-initialization with the current warm code cache, including launcher overhead. Test changed environment and installation paths before expanding to worker initialization; table-only savings may be too small to justify it.

The ceiling is the remaining framework **execution/initialization** time after current bytecode caches, lazy imports and standby overlap. Test discovery, user imports and browser/application work remain. Snapshots may reduce startup CPU but increase distribution size, page faults or restored heap size; they do not automatically share mutable heaps between workers.

When resources permit, attribute startup with the current code cache warm and cold before building a full snapshot. Then compare cold CI, immediate repeated runs, warmed sessions and failure-heavy suites at one/four workers. Include generation cost and resident memory; use the [whole matrix and old-fork comparison](01-browser-native-actions.md#payoff-and-decision-test). Run `tests/page` on `chromium-page`, `tests/playwright-test` and packaging/consumer checks across supported Node 20–24 versions, with unsupported versions falling back, against pristine upstream. Abandon the snapshot path if the remaining critical-path initialization is small or runtime maintenance outweighs repeatable complete-run gains.
