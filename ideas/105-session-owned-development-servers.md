# Keep declared reusable development servers warm between runs

Scope: repeated local test commands whose application server or bundler starts slowly. Effort: large runner work. Compatibility: explicit server-lifetime and reset contract. Potential: remove repeated application startup from the edit/test loop.

Research, 2026-10-31, against `913231d4`, the live worktree and linked primary documentation. No servers or watchers started.

## Evidence and distinction

Flashwright's [warm session](../packages/playwright/src/runner/session.ts) retains browser capacity between commands. [`WebServerPlugin`](../packages/playwright/src/plugins/webServerPlugin.ts) still owns a launched server's shutdown through `_killProcess` and calls it during teardown. An externally managed server can already be reused through [`reuseExistingServer`](https://playwright.dev/docs/test-webserver); merely enabling that existing option is not this proposal.

The missing facility is runner-managed ownership across commands: keep a server started by Flashwright, verify it belongs to the compatible session, and know when it is safe to reuse. This can also preserve a bundler's in-memory transforms. [Vite's warmup documentation](https://vite.dev/config/server-options#server-warmup) confirms that transforming and caching application files can affect initial page load; it does not establish any Flashwright speedup.

[Idea 27](27-parallel-web-server-startup.md) overlaps independent launches within one command. [Idea 39](39-checkpointed-application-backends.md) restores separate backend snapshots. Here one declared reusable process survives several commands, with no VM or heap snapshot.

## Proposed change

Add an opt-in session lifetime for a managed `webServer`. The session owns its process group and lends a run an exclusive lease. Key compatibility by resolved command/cwd, effective environment, executable/dependency identity, server configuration and declared restart inputs. Do not persist secret environment values in a public manifest.

At acquisition, verify process ownership and liveness, run an optional application reset hook, then wait for a current-build readiness barrier. A listening port alone cannot prove that an edited application is ready. Start with an adapter for one watching dev server that acknowledges the requested source generation; unsupported servers restart normally after relevant edits.

Allow server authors to distinguish application edits handled by their watcher from changes requiring restart, such as dependencies, environment or server configuration. Honor generated environment outputs from readiness patterns. Reset failure, incompatible identity, missed watcher events or unknown freshness must cause a clean restart before tests begin.

Keep logs scoped to the leasing run while retaining enough startup context for failures. Release the lease after ordinary run teardown. Shut down the complete owned process tree on session expiry, explicit stop or incompatibility. Concurrent runs need separate instances or serialization, never accidental sharing of a mutable backend.

## Functional boundary

Keeping a process alive changes startup side-effect frequency and state lifetime. Require an explicit declaration that the server is stateless across runs or supplies a complete reset. Do not infer this from a command containing `vite` or from `reuseExistingServer: true`. Ordinary per-run launch remains the opt-out; document the new contract in README before shipping.

Fresh tests, configs, global setup, browser contexts and fixtures still execute normally. Server restart tests and projects depending on process startup effects retain the existing mode.

## Payoff and later decision

The target is launch plus initial compilation time minus lease, reset and freshness checks. It can dominate a short rerun, but offers no automatic benefit to single-run CI or users who already manage a warm server. Retained RAM and idle watcher CPU are costs, not free savings.

Later compare cold and repeated runs, source/env/dependency edits, stale readiness, crashes, cancellation and concurrent commands. Check complete cleanup and reset behavior in web-server/session tests, then report mode-specific results beside the [full matrix and upstream procedure](01-browser-native-actions.md#payoff-and-decision-test). Include first startup and final shutdown across a complete sequence of runs.

**Assessed 2026-10-31:** candidate, needs an owner decision on the lifetime contract. The warm session already hands browsers from run to run, but every run still starts and stops `webServer`: 0.5-10 s for a dev server, against ~80 ms for the rest of a warm re-run of one test. Proposed contract: only with `reuseExistingServer: true` (the config already accepts a server that is running), only for the same command, cwd and environment, with the server's output handed to the session and the server stopped when the session ends.
