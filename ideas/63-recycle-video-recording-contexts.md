# Keep the warm context when a test records video

Scope: Chromium suites using video on every attempt, including retain-on-failure. Effort: large. Priority: a strong architectural candidate for those suites, using the existing browser build.

**Assessed 2026-10-31:** implemented (`2e3fb73c`). TodoMVC with `video: 'retain-on-failure'`: 2850 -> 1300 ms; `video: 'on'`: 1640 ms. Every attempt that records video now uses the recycled context: its tab starts recording when the test gets it, the videos end before the context is reset, and are written while the next test runs; a recorder that failed to start is still reported when the test's context closes. Modes that record only some attempts keep a new context for those attempts.

Research, 2026-10-31, against `2bc2768b` plus the live worktree. Source inspection only; no implementation or performance measurements.

## Evidence and opportunity

The [`context` fixture](../packages/playwright/src/index.ts) sends attempts that capture video through `_contextFactory`, which calls `browser.newContext()`. `_recycleContext` admits only video modes with non-recording attempts. Therefore video recording loses the normal recycled-context path even when the eventual passing-test video is discarded.

[`startAutomaticVideoRecording`](../packages/playwright-core/src/server/videoRecorder.ts) already creates a recorder and artifact per page. The remaining coupling is context configuration, fixture cleanup and artifact ownership. [Idea 17](17-direct-video-encoding.md) removes intermediate JPEG encoding; it explicitly leaves this lifecycle problem separate. This proposal keeps the existing codec and capture pipeline.

## Proposed change

Separate an attempt's recording session from the physical context's lifetime. Each logical test context gets its own recording configuration, output ownership and list of page artifacts. Recycle the underlying Chromium context while creating a fresh page and a fresh recorder for each attempt.

Install recording before the new page resumes, as the existing recorder requires. Do not create a reusable standby page that records reset activity or misses the application's first frame. Configure recording before target creation, or discard an incompatible standby page.

At the boundary, close every old page, stop its screencast clients, drain its encoders and finalize its artifacts. Only then complete logical context teardown and release that attempt's recording session. Keep the existing storage/input/network reset. A later optimization could overlap independent encoder drain with preparation, but the first version should retain the full completion barrier.

Start with one worker and `video: 'on'`, then add retain modes, retries, popups and page-specific recording options. Keep browser handoff between Node processes disabled for recording contexts initially. [`prepareForHandoff`](../packages/playwright-core/src/server/browserContext.ts) currently rejects them for a reason: process-owned artifact state must not be inherited accidentally.

## Compatibility boundary

Preserve capture cadence, first/last frames, dimensions, overlays, timestamps and the current final hold. Do not join two attempts into one video or recover the boundary by trimming afterward. `page.video()`, `saveAs()`, deletion, manually closed pages and context-close errors need independent per-attempt ownership.

Preserve the existing retain/discard decision after the test outcome is known. Recycled storage must satisfy the same isolation checks as video-free tests. `isolation: 'strict'` remains the fresh-context opt-out; unsupported recording combinations retain their current path. Document that video becomes eligible for the already documented recycled-isolation mode.

## Payoff and later decision

The target is repeated context setup and loss of useful renderer warmth, not encoding time. The size of that loss is unmeasured here, and the browser may already reuse some compilation work across fresh contexts. Record both lifecycle and encoder costs before attributing a gain.

Later compare the current fork and candidate with identical recording settings, including discarded passing videos. Cover video/library tests, retry/artifact runner tests and recycle isolation. Run upstream `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report the full `node bench/matrix.mjs` and `node bench/run.mjs <scenario> <workers> <iterations> stock,fork`, adding video rows and current-fork controls under the [shared evaluation rules](01-browser-native-actions.md#payoff-and-decision-test). Count every encoder drain and retained process. No experiments while this machine is busy.
