# Public default ARIA snapshots

Flashwright provides `Page.ariaSnapshot()` and `Locator.ariaSnapshot()` with focused evidence based on `70dc299f`. Its focused acceptance matrix passes on macOS arm64 with full Chromium 148.0.7778.96 and Playwright 1.60.0 as the reference. The [combined integration checkpoint](../compatibility/evidence/artifact-integration-checkpoint-2026-10-10.json) passes all 179 core groups with default failure diagnostics at source `666a2a8f`, plus fresh Bun/Node22/Node24 consumers. These results establish the tested behavior; they make no speed, release-platform or broad parity claim.

The [final checkpoint](../compatibility/evidence/public-default-aria-checkpoint-2026-10-10.json) contains production/test source hashes, shared outcomes, raw-artifact receipts and cleanup results. The [earlier host ledger](../compatibility/evidence/public-default-aria-host-2026-10-10.json) is a historical development record, superseded for current gate status by that checkpoint. Raw reports, traces, screenshots and failed attempts remain in ignored local evidence directories; the public checkpoint contains no host paths.

## Contract and implementation

Both methods return a string. Options accept primitive omitted/default `mode`, boolean `boxes`, integer `depth`, and the existing inherited/explicit timeout policy. Zero depth means unlimited; negative depth renders an empty result. Timeout zero is unbounded. Boxed values and invalid primitives reject. AI mode and unknown options reject with `UnsupportedFeatureError` before trace owner lookup or native browser work; public AI refs and recursive frame composition are outside this slice.

Page capture starts at the current body and retries while it is absent. Locator capture uses strict selection, retries absence, and permits an empty result for a present hidden target. Same-process frame locators resolve the existing lazy frame path. Each Locator attempt first waits for the owned pending main-frame navigation. One `aria.snapshot` operation carries the deadline through navigation, frame resolution, retries and capture, with original-root and selected-frame document checks around the result. Remote frame evaluation rejects with the public operation name.

A dedicated resident helper calls the unchanged pinned `injected.ariaSnapshot`. The native call awaits the actual asynchronous wrapper. The renderer retains upstream default last-snapshot map replacement; Page capture excludes child documents. There is no assertion predicate or Playwright browser fallback in this implementation.

Requests and returned strings each have a 100,000 UTF-16-unit bound. Output is measured before codec encoding and rejected atomically with `ResourceLimitError`, without truncation. Raw selector JSON preserves escaped lone surrogates for the JavaScript parser, and results use the existing lossless codec. This output bound does not bound Chromium DOM/tree allocations or synchronous renderer CPU: the renderer builds its tree and string before admission. Already dispatched synchronous work can update its internal snapshot map even if the operation later times out or rejects its output.

Trace preparation reads application option getters once and validates before trace lookup/begin. This opt-in preparation preserves the existing wrapper for unrelated APIs. Valid public snapshot getters record Frame actions and filmstrip activity, with no DOM snapshot references or captures, matching the pinned reference policy. Source-enabled traces embed the caller. The pinned viewer hides getter actions by default; the viewer check explicitly enables its Getters filter.

## Verified matrix

| Gate | Bun 1.4.2 | Node 22.22.0 | Node 24.15.0 |
| --- | --- | --- | --- |
| Controlled host/resident groups | 11 passed | 11 passed | 11 passed |
| Actual packaged Page/Locator option and trace prevalidation | 22 passed | 22 passed | 22 passed |
| Remote-placement evidence checker | 9 passed | 9 passed | 9 passed |
| Shared browser groups, each engine | 12 passed, exact outcomes equal | 12 passed, exact outcomes equal | 12 passed, exact outcomes equal |
| Candidate AI rejection, output limit and recovery | Passed | Passed | Passed |
| Source-enabled getter trace artifacts, both engines | Passed | Passed | Passed |
| Fresh Bun-installed tarball consumer, ESM/CommonJS and declarations | Passed | Passed | Passed |

The twelve shared browser groups cover default/depth behavior; strict, hidden and missing targets; inherited and explicit-zero timeout; absent Page body; Unicode, shadow content and rounded boxes; same-process frame selection; frame replacement; delayed navigation with a still-matching predecessor; missing-target root navigation; blocked-renderer deadline and late reply isolation; and owner closure during both blocked capture and missing-target retry.

Additional gates passed:

- The live remote-frame test proves the same discovered iframe target and original child process swap before and after typed rejection. Offline replay of both exact record prefixes reproduces those proofs. It does not claim child-world execution; the driver does not attach a child session.
- The actual pinned trace viewer renders both engines' two getter actions, return value, embedded source and highlighted caller with zero page errors. Editor bytes match source bytes inside each ZIP. No pixel-fidelity claim is made.
- All 311 engine tests pass, and engine clippy passes for all targets with `-D warnings`; the existing `hyper-util` dependency warning remains. Native and package builds, strict core TypeScript checking and changed Rust formatting pass.
- Every selected browser, viewer, remote and packed-consumer run exited zero without watchdog timeout, cleanup signals or remaining observed processes. Artifact receipts retain these checks independently of the feature reports.

## Reproduction

Use the development setup in SPECS S18 and verification policy in S19. Build the driver with `bun tools/build-driver.mjs` and build the packages. Set `FLASHWRIGHT_DRIVER_PATH` to that driver and `FLASHWRIGHT_BROWSER_PATH` to the full Chromium executable used for both engines. For a Node coordinator, set `FLASHWRIGHT_BUN_PATH` to the Bun executable used by the fresh package installer. Choose new output directories for each attempt.

```sh
bun tools/test-public-aria-snapshot.mjs
bun tools/test-public-aria-packaged-validation.mjs
bun test ./tools/test-public-aria-remote-target.mjs
mkdir -p .cache/aria-rerun .cache/aria-remote-rerun .cache/aria-viewer-rerun .cache/aria-packed-rerun
python3 tools/watchdog.py --timeout 180 --report .cache/aria-rerun/resources.json -- bun tools/run-public-aria-snapshot-tests.mjs .cache/aria-rerun
python3 tools/watchdog.py --timeout 120 --report .cache/aria-remote-rerun/resources.json -- bun tools/run-public-aria-remote-rejection.mjs .cache/aria-remote-rerun
python3 tools/watchdog.py --timeout 120 --report .cache/aria-viewer-rerun/resources.json -- bun tools/test-public-aria-viewer.mjs .cache/aria-rerun/report.json .cache/aria-viewer-rerun/artifacts
python3 tools/watchdog.py --timeout 180 --report .cache/aria-packed-rerun/resources.json -- bun tools/test-packed-public-aria.mjs .cache/aria-packed-rerun/artifacts
```

Repeat the shared and packaged runs with each supported Node binary; use `node --test` for the remote-evidence unit suite. These focused gates do not replace the merged full suite. Coordinate browser runs with other experiments so they do not contaminate benchmark measurements.

## Retained failed attempts

The checkpoint preserves hashes and clean watchdog receipts for failed runs, rather than replacing them with later passes.

| Attempt | Finding and correction |
| --- | --- |
| First native build | Missing `check_exception` import; corrected before the successful native builds. |
| First Bun differential | One enormous accessible name did not test the output limit because the pinned renderer omits names over 900 characters. The fixture now uses many ordinary-sized names. |
| Second Bun differential | Getter traces declared missing DOM references and emitted extra captures. Production tracing was corrected to the observed filmstrip-only getter policy. |
| First remote run | Existing `page.goto` remote-child lifecycle rejection prevented reaching ARIA. The fixture now loads the parent and installs the remote SVG dynamically; that navigation gap remains outside this slice. |
| First viewer run | The pinned viewer hides getters; the fixture now enables its Getters filter. |
| Second viewer run | The source filename became visible before the editor loaded; the fixture now waits for actual CodeMirror source text. |

Upstream contract provenance is Playwright 1.60.0's `Frame.ariaSnapshot`, `ariaSnapshotForFrame`, public declarations, getter action metadata and retained injected renderer. No upstream source was changed or newly copied; existing extraction and licensing notices continue to apply.
