# Share browsers across isolated Node workers

**Scope:** parallel suites whose Node globals must remain isolated. **Effort:** large. **Priority:** high for browser startup and memory pressure; conditional for warm, action-heavy runs.

**Assessed 2026-10-31:** deferred. Sharing one browser among separate worker processes adds a hop to every call; `workersPerProcess` already shares a browser within a process (TodoMVC 4 workers: 795 -> 493 MB, 1.12× faster with 4 per process).

Research proposal, 2026-10-31. Source inspection and primary-source research only; no builds, tests or measurements. This separates browser sharing from the existing `workersPerProcess` option.

## Evidence

[`joinSharedBrowser`](../packages/playwright/src/index.ts) keeps a process-local browser map and assigns recycled-context slots to worker lanes. Sharing therefore accompanies sharing the Node process, including its globals and module cache. Ordinary process-isolated workers do not use that map together.

The transport primitive already exists: [`BrowserServerLauncherImpl`](../packages/playwright-core/src/browserServerImpl.ts) launches a browser server, and [`PlaywrightDispatcher`](../packages/playwright-core/src/server/dispatchers/playwrightDispatcher.ts) can expose a prelaunched browser with connection-scoped contexts. [BrowserType.connect](https://playwright.dev/docs/api/class-browsertype#browser-type-connect) is a supported API. Merely connecting several workers to a browser is not a new invention. The opportunity is a runner-owned pool with correct recycle, artifact and worker-failure lifetimes.

## Proposed change

Introduce a browser broker that lives outside test workers. Keep each worker in its own Node process, but lease a logical browser connection from a bounded pool. Group leases by the full launch identity: engine/revision, executable, arguments, environment, proxy and other process-wide settings. Start with one project and ordinary nonpersistent contexts.

Each connection owns its contexts, recycled slots, downloads, traces and pending calls. Allocate slot IDs at the broker rather than accepting a worker's unqualified default slot. On worker exit, stop its operations, finish required artifacts and reset or destroy its contexts before reassigning the lease. A crashed Node worker must not leave a live page producing events in its replacement's slot.

Use the existing server transport for a first implementation. Only consider a local binary transport if the extra hop outweighs launch savings. Cap the number of workers per physical browser; one browser for the whole suite can become a bottleneck. Coordinate with speculative launch and the warm session so they do not start redundant browsers.

## Compatibility

Node process isolation remains intact. Preserve `process.env`, module globals, worker fixtures, worker restart and context visibility. `isolation: 'strict'` still creates fresh contexts. Existing remote-dispatch options are building blocks, not proof that recycled contexts are already connection-isolated.

Browser-process failure now affects several workers. Browser-wide CDP commands and browser process handles cannot be made private by hiding context lists. Introduce an explicit pool mode, document these differences in README, and retain dedicated browsers for those workloads. Define `browser.close()` as closing the caller's logical browser and owned contexts in this mode; never silently kill other leases or ignore the call. Persistent profiles and unsupported launch combinations stay dedicated.

## Payoff and later decision

The target is fewer browser/network/GPU utility processes and fewer repeated launches, while retaining separate test processes. This can reduce CPU and memory together, particularly during failure restarts. It does not eliminate renderer work. Broker serialization, contention and correlated crashes may outweigh the gain.

First compare dedicated workers, today's shared-process lanes, and process-isolated workers using a broker. Include cold/warm runs, worker crashes, close calls, incompatible options and artifact cleanup. Require a wall-time gain, not only lower RSS.

When the machine is free, run connection/browser-server coverage, `tests/page` on `chromium-page` and `tests/playwright-test`, comparing failures and flake rates with pristine upstream in `workbench/pw-src`. Report the full `node bench/matrix.mjs` and `node bench/run.mjs <scenario> <workers> <iterations> stock,fork`, plus current-fork comparisons under the [shared evaluation rules](01-browser-native-actions.md#payoff-and-decision-test). Count broker startup, all resident processes and final cleanup.
