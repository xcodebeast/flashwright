# Flashwright

Flashwright is building a Rust browser-testing engine with a TypeScript API compatible with a declared subset of Playwright. The goal is lower action and assertion latency and better complete-suite throughput while preserving real Chromium behavior

## R1 Current state

The development library now launches real Chromium through a persistent Rust driver, owns contexts and pages, evaluates JavaScript values, navigates real HTTP pages and observes network responses. Locators resolve through the pinned selector runtime in isolated document realms; the tested slice includes reads, waits, child-frame queries, native text fill, selection, focus, clicks, hover, checkbox actions and locator/page keyboard presses. Native pointer tests cover trusted events, fresh frame stability, hit interception, nested frames and navigation completion. ESM/CommonJS npm consumers and failure recovery are exercised against the pinned browser. Retrying DOM assertions and an experimental native fixture adapter now run through the pinned test scheduler, including extended fixtures, retries, soft assertions and timeout teardown. The three preserved TodoMVC tests pass through freshly packed packages with import/config changes only. Broader runner, artifact and API coverage remains unfinished. The latest completed headless-shell profiles, for the preceding indexed-query binary, measured about 5.5–6.7% less complete-run time and passed its sustained-load resource gates. The new private evaluation helper passes development conformance; its performance comparisons are pending. The material performance and release gates remain open

[SPECS.md](SPECS.md) defines the implementation and release gates. [Milestones](compatibility/milestones.json) track completed evidence and remaining work. [Reference manifest](compatibility/reference-manifest.json) records exact versions, retained runs and platform limitations

## R2 Development

Bootstrap installs Node inside this checkout and verifies its archive against the official SHA-256 manifest. It requires Python 3.12 or later and curl. Rust is pinned by rust-toolchain.toml

```sh
export PATH="$(python3 tools/bootstrap.py):$PATH"
npm ci --ignore-scripts
npm run inventory:check
npm run typecheck
npm run test:harness
python3 tools/watchdog.py --timeout 60 -- npm run test:runner-boundary
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

The runner probe deliberately fails one attempt to test retries and deliberately times out another test. Its wrapper checks those exact outcomes, soft failures, attachments and fixture teardown, and exits successfully only when all expectations hold. Its upstream browser and request launch methods are poisoned to detect accidental use

For Node 22, use `python3 tools/bootstrap.py --version 22.22.0` when setting PATH. The copied upstream migration bodies use their own Bundler-resolution configuration. Packed library and runner consumers are checked separately with NodeNext ESM and CommonJS declarations. Both entry points share one runtime so browser class identity, error identity and runner state remain consistent in mixed consumers

After installing the pinned browser, build and verify the core:

```sh
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install chromium
npm run verify:core
```

Verification retains source hashes, command logs, the driver hash and results under compatibility/evidence. It includes browser isolation and value round trips, cancellation during resource creation, infinite JavaScript, stopped or killed drivers, worker death, malformed streams and blocked output. Shared Playwright/Flashwright fixtures compare navigation, response bodies, selector semantics, replacements, shadow DOM, child frames and input-event records, including all 212 pinned key descriptions and platform editing shortcuts. Fault cases verify that a timed-out date fill does not mutate the document after recovery, pointer and keyboard cancellation release held input, and a blocked input handler closes the affected page. Public objects observe browser and renderer crashes. The process guardian owns browser and temporary-profile cleanup even when the driver dies. Retrying assertion tests cover missing targets, negation, complete-value matching, bounded diagnostics, blocked renderers and context closure. Packed runner tests verify the installed CLI, fixture generics, reporter declarations and shared ESM/CommonJS identities. The renderer-crash profile cleanup repair waits for the complete owned process group and retains the guardian through slow filesystem cleanup. The [repair evidence](compatibility/evidence/profile-cleanup-repair-2026-10-07/report.json) preserves both reproduced failures, the ownership regression tests and 120 successful crash/close cycles

The core suite also runs `npm run test:migration`, which installs packed packages into a fresh consumer, type-checks the retained TodoMVC tests and runs both engines against the public demo. This check needs external network access because the original fixture keeps its hardcoded URL. It compares application asset hashes before and after the runs, preserves test/fixture bodies and disables the upstream browser backend for Flashwright. Page-level keyboard presses retain existing focus and do not inherit locator timeouts or wait for navigation; their cancellation still follows page/context ownership

To try the library from this checkout:

```sh
npm run build
export FLASHWRIGHT_DRIVER_PATH="$PWD/target/debug/flashwright-driver"
export FLASHWRIGHT_BROWSER_PATH="$(node --input-type=module -e "import { chromium } from 'playwright'; process.stdout.write(chromium.executablePath())")"
node --input-type=module <<'JAVASCRIPT'
import { chromium } from 'flashwright';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  console.log(await page.evaluate(({ answer }) => answer, { answer: 42 }));
} finally {
  await browser.close();
}
JAVASCRIPT
```

The explicit driver path is a development requirement. Published platform binaries, automatic runtime selection and the pnpm/Yarn consumer matrix remain open. [Development coverage](compatibility/development-coverage.json) describes the small implemented slice; the release inventory does not yet mark it supported. Chromium's default argument lists are now extracted from the pinned reference, and the shared benchmark-contract check compares actual launch logs from both engines

## R3 Browser baselines

Install the pinned reference Chromium explicitly if it is absent. No npm install script downloads a browser

```sh
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install chromium
npm run baseline
node tools/verify-baseline.mjs benchmarks/results/RETAINED_RUN_DIRECTORY
```

The harness defaults to full Chromium revision 1223, verifies version 148.0.7778.96, hashes its executable, and records actual launch flags. `FLASHWRIGHT_BROWSER_PATH` selects an existing binary. New core reports bind its exact path, hash, version and distribution; benchmark admission requires that same browser. To install the pinned headless shell separately, use `PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install chromium-headless-shell` and set the browser path to its executable. Workloads include trusted input, delayed assertions, navigation, fresh contexts, real HTTP work and expected failures. All attempts are retained. An invalid run is never used as speed evidence

The external watchdog bounds the whole job, samples the observed process tree, and cleans up observed descendants. Its sampling limitations are recorded with the measurements. It is a disclosed job budget, not a public API timeout

For paired engineering measurements, build the optimized driver and verify that exact executable first:

```sh
cargo build --workspace --release --locked
export FLASHWRIGHT_DRIVER_PATH="$PWD/target/release/flashwright-driver"
npm run verify:core
```

Set `FLASHWRIGHT_VERIFICATION_REPORT` to the passed report path printed by verification, then run `npm run benchmark:paired`. The harness refuses changed sources or a different driver, alternates engine order across eight independent launch pairs, and retains every attempted sample. Run `node tools/verify-paired.mjs RETAINED_RUN_DIRECTORY` on the resulting directory. Timing conclusions require a valid complete run; the one-pair `test:benchmark-contract` check only verifies behavior and the harness. A valid profile remains scoped to its seven workloads, one worker and recorded machine; it does not satisfy full preview, contention, native Linux or release gates

The retained [first paired profile](benchmarks/results/2026-10-07T19-04-45.711Z-darwin-arm64-paired-3d9a92ed/summary.json) identified excess input scheduling cost. The [ordered-input profile](benchmarks/results/2026-10-07T19-50-41.891Z-darwin-arm64-paired-a4803183/summary.json) removed that interaction regression but did not meet the complete-flow material-improvement target. Shared-host conditions change between runs; use the paired comparison within each snapshot rather than historical totals to assess an engine advantage.

For diagnostic protocol accounting, use `npm run benchmark:attribution` with the same verified-driver setup, then `node tools/verify-attribution.mjs RETAINED_RUN_DIRECTORY`. A byte-preserving external proxy records CDP command metadata and byte counts without argument/result payloads. Clock calibration bounds correlation between the Node workload and proxy; acknowledgement intervals are combined without double counting overlap. These instrumented timings are diagnostic evidence, separate from production speed measurements.

The [first attribution checkpoint](compatibility/evidence/cleanup-attribution-checkpoint-2026-10-07.json) retains four verified launches. Flashwright sent 972 browser commands per launch versus 2,363–2,444 for Playwright, despite the ordinary paired benchmark remaining near parity. The delayed assertion spent a median 23.12 ms outside browser acknowledgements in a 24.31 ms operation, consistent with the host's 20 ms retry sleep. Browser setup was dominated by creation, initialization and navigation acknowledgements. This motivated resident assertion detection. The same checkpoint includes the failed-test cleanup repair, 48 passing core checks across macOS and emulated Linux, and a clean final process/profile audit.

`npm run test:conditions` exercises the resident condition registry in an isolated Chromium realm with the existing full assertion predicate. Its 57 cases cover synchronous query sharing, cache scope boundaries, callback exclusion, paced fallback, mutation and fallback detection, property/CSSOM/viewport/focus changes, shadow discovery bounds, replacement, transient and negated states, cancellation, deadlines, document replacement, mutation storms, bounded reevaluation batches, queue fairness, CSS animation, font completion/failure and real lifecycle suspension/recovery. A separate fault-injection case withholds only registry frame callbacks to verify timer fallback. Already-true conditions skip discovery; concurrent pending conditions share it. The engine integrates the registry behind `FLASHWRIGHT_RESIDENT_ASSERTIONS=1`, with residency off by default. Host deadlines remain authoritative, and blocked-renderer cancellation retains exact-context cleanup without terminating unrelated application JavaScript.

The [integrated residency checkpoint](compatibility/evidence/resident-integrated-checkpoint-2026-10-07.json) records host cancellation and lifecycle coverage in both modes, plus the initial full-Chrome off/on and Playwright comparisons. Delayed assertions improved substantially, while full-Chrome complete runs remained near parity. Residency stays opt-in while the remaining condition-resource and release gates are open.

To reproduce the off/on comparison, verify the same optimized executable with residency disabled and enabled. Set `FLASHWRIGHT_BASELINE_VERIFICATION_REPORT` to the disabled report and `FLASHWRIGHT_VERIFICATION_REPORT` to the enabled report, then run `npm run benchmark:residency`. Run `node tools/verify-residency.mjs RETAINED_RUN_DIRECTORY` to independently check the result. Both modes include preparation and use the same binary; diagnostic counters are disabled. A Playwright comparison uses `benchmark:paired` with `FLASHWRIGHT_RESIDENT_ASSERTIONS=1` and the matching enabled core report.

The [headless-shell checkpoint](compatibility/evidence/browser-distribution-checkpoint-2026-10-07.json) verifies both modes on the pinned shell distribution and closes the browser-identity gap in benchmark admission. Full Chrome and shell remain distinct result classes, with the same executable and flags used by both engines within each comparison.

The [ASCII runtime checkpoint](compatibility/evidence/ascii-runtime-checkpoint-2026-10-07.json) retains 100 passing core checks at 142 identical source hashes across macOS modes/distributions and emulated Linux, plus focused Node 22 checks. A literal Unicode diagnostic character increased runtime installation cost; its JavaScript escape preserves the exact output and avoids the regression. The build now enforces ASCII resident source. The independently verified component experiment covers 360 fresh-document installations; reproduce it with `node benchmarks/runtime-installation.mjs` under the external watchdog, then `node tools/verify-runtime-installation.mjs RETAINED_DIRECTORY`.

The [resident fairness checkpoint](compatibility/evidence/resident-fairness-checkpoint-2026-10-08.json) retains 100 passing verification groups at 142 matching source hashes across macOS modes/distributions and emulated Linux, plus focused Node 22 checks. A pre-repair reproduction ran 256 full locator rechecks before a zero-delay browser timer could run. That checkpoint introduced a fair queue yielding after eight starts or four elapsed milliseconds, checked between complete predicates. The later selector-sharing checkpoint below raises the start cap while preserving the elapsed-time budget. Cancellation closes the scheduling ports and retires queued work. One expensive synchronous predicate remains indivisible.

Two independently verified headless-shell Playwright comparisons measured about 11.5% and 4.9% less complete-run time, with paired ratios 1.1303 (95% interval 1.0547–1.1719) and 1.0515 (1.0090–1.0734). Delayed assertion ratios were 2.42 and 2.39. Only the first snapshot cleared the configured 10% material threshold; its larger setup advantage did not repeat. Both profiles retain small-call and failure-path median regressions, so the material target remains open and residency stays opt-in. These shared-host, single-worker measurements do not complete release, contention or native Linux gates.

The [resident invalidation checkpoint](compatibility/evidence/resident-invalidation-checkpoint-2026-10-08.json) records 100 passing verification groups at 146 matching source hashes, plus Node 22 checks. A small original font fixture changes geometry through a real HTTP load without a DOM mutation; separate cases verify font-event wakeups, failed loads and transient CSS animation. Dedicated lifecycle targets prove suspension through freeze/resume events and stopped application/registry counters. They omit the reference driver's focus emulation, which otherwise keeps the page visible and prevents freezing. These lifecycle fault cases are distinct from default-launch performance measurements. The production sources and measured optimized binary are unchanged. The subsequent resource measurements are recorded below.

The [sustained-load checkpoint](compatibility/evidence/resident-load-checkpoint-2026-10-08.json) retains a corrected 162-launch comparison on native Apple M3 Pro macOS, with Playwright 1.60.0 and the same Chromium headless shell. Quiet text, property-only changes and continuous mutations each run at 1, 32 and 128 pending assertions. Every launch completes 80 application tasks, one real backend request and all assertions; all six engine orders are covered. The same optimized driver passes 52 current core verification groups. Residency reduces complete time by 10.7–13.2% in these cases, but fails seven CPU gates and all three 32-condition memory gates. At 32 conditions, CPU is 1.97–2.18x Playwright's and peak memory is 15.9–19.3% higher. These are six-pair engineering observations, not suite, contention, native Linux or release acceptance. Residency remains off by default.

The [CPU accounting repair](compatibility/evidence/resident-load-accounting-2026-10-08/report.json) reproduces macOS reporting zero CPU for an unreaped process after earlier positive observations. The watchdog now preserves maximum observed CPU per process identity and retains every process sample for independent recomputation. The first load matrix is retained but excluded from resource acceptance; historical watchdog CPU totals without schema version 2 have the same limitation. The corrected verifier checks raw CPU maxima, concurrent RSS, exact work, paired statistics and bundled conformance logs. Its relocation and corruption probes pass.

Run `npm run test:resident-load` for functional harness checks. To reproduce the complete matrix, verify the selected optimized driver in both residency modes, set `FLASHWRIGHT_VERIFICATION_REPORT` to the residency-on report and `FLASHWRIGHT_BASELINE_VERIFICATION_REPORT` to the residency-off report, then run `npm run benchmark:resident-load`. Check the retained directory with `node tools/verify-resident-load.mjs RETAINED_DIRECTORY`. Counter diagnostics in the functional reports are explicitly separate from ordinary timing.

The [selector-sharing checkpoint](compatibility/evidence/resident-query-checkpoint-2026-10-08.json) records 104 passing core groups at 158 matching source hashes, plus Node 22 checks and 49 registry cases. Read-only assertions share selector work within one synchronous batch; every complete predicate still runs, and cache scope closes before a microtask, task or application callback. A 32-condition fixture performs 32 fresh predicates with one native query. The scheduler permits 32 starts within its four-millisecond budget and paces fallback after the first 100 milliseconds of a wait; mutation, event and font wakeups remain immediate. The [predeclared production comparisons](compatibility/evidence/resident-query-profile-plan-2026-10-08.json) are now complete and recorded below. Residency stays off by default.

The functional load harness uses an explicit 60-second assertion deadline and 90-second watchdog to retain the full work under CPU emulation. Its samples are labeled and rejected from production comparisons, which retain the original 15-second assertion deadline, 45-second watchdog and resource thresholds. The retained first Linux attempt completed only 79 of 80 application tasks before that production deadline with 128 host-polled assertions. Passing with the functional budget does not establish performance acceptance.

The [query performance checkpoint](compatibility/evidence/resident-query-performance-checkpoint-2026-10-08.json) retains all 210 ordinary launches and independent verification. The nine sustained-load scenarios now pass every memory and complete-time gate; seven pass the CPU gate. At 32 and 128 concurrent assertions, resident CPU cost is below the matched Playwright baseline. One pending property-only or mutation-text assertion still exceeds the 10% CPU-growth limit, with paired Playwright/resident CPU ratios 0.850 and 0.827. At that checkpoint, the registry still requested frames even when full predicate work was deferred. The subsequent wakeup experiment is recorded below.

Those two seven-workload Playwright comparisons show complete-run ratios 1.0580 (95% interval 1.0464–1.0688) and 1.0548 (1.0395–1.0901), about 5.5% and 5.2% less time. Delayed assertion ratios are 2.503 and 2.393. Both miss the configured 10% material target and retain noop/failure median regressions; the first also flags noop/navigation observed maxima. The same-binary off/on comparison shows a 1.0482 ratio. These are single-worker shared-host engineering results, not broad-suite, native Linux, contention or release acceptance. The verifier-only repair between snapshots changed neither production inputs nor recorded measurements; 52 fresh core groups and versioning/corruption checks cover that change.

The [frame-pacing checkpoint](compatibility/evidence/resident-frame-pacing-checkpoint-2026-10-08.json) records 104 passing core groups at 158 matching source hashes, Node 22 checks and 52 registry cases. Long waits now use the next due timer directly; short waits retain frame checks, and events still invalidate immediately. Concurrent completed checks share planning work, and cancelled callbacks cannot disturb a successor group.

The [frame-pacing performance checkpoint](compatibility/evidence/resident-frame-pacing-performance-checkpoint-2026-10-08.json) retains all 210 verified ordinary launches. Every memory and complete-time gate passes, as do the six concurrent CPU gates. All three single-condition CPU gates fail, with paired Playwright/resident ratios 0.905, 0.896 and 0.856. Two complete-flow comparisons show about 4.5% and 6.6% less time, below the 10% material target. Noop regressions remain in both; the first also flags failure-path latency. Residency remains off by default.

Separate [timer diagnostics](compatibility/evidence/resident-frame-pacing-exploration-2026-10-08/timer-fragmentation-report.json) explain why fewer frame callbacks are insufficient: slightly staggered checks create many small timer batches. A controlled clock reproduces 425–524 timer callbacks per simulated second at 32/128 conditions, versus 28 with simultaneous starts. This identifies a scheduling mechanism, not an attributed browser CPU improvement. Those results motivated the group-coalescing repair below; the recorded experiment did not meet resource or release acceptance.

The [timer coalescing checkpoint](compatibility/evidence/resident-coalescing-final-checkpoint-2026-10-08.json) records 104 current core groups, Node 22 checks and 54 registry cases. A due fallback timer checks the pending group together; frame callbacks still pace individual waits, and events remain immediate. The four-millisecond scheduling window and independent deadlines are retained. A staggered-registration regression reproduced why the first window-only repair was insufficient; its complete conformance and diagnostics remain in the [initial record](compatibility/evidence/resident-coalescing-initial-exploration-2026-10-08/report.json).

All thirteen separate counter diagnostics verify their full application work. The four isolated concurrent quiet/property cases use 50–51 timer callbacks over about two seconds. Four earlier smoke cases ran concurrently with Linux functional verification and are kept separate. These are instrumented scheduling observations, not CPU or speed claims. The [ordinary comparison plan](compatibility/evidence/resident-coalescing-final-profile-plan-2026-10-08.json) is complete, with all 210 launches independently verified at unchanged work/resource thresholds.

The [timer-coalescing performance checkpoint](compatibility/evidence/resident-coalescing-final-performance-checkpoint-2026-10-08.json) passes all nine memory and complete-time load gates and eight of nine CPU gates. Mutation-text with one condition remains over the CPU budget: paired Playwright/resident CPU ratio 0.8953 (95% bootstrap interval 0.8036–0.9421), or about 11.7% more resident CPU. At 32/128 concurrent conditions the paired CPU ratios are 1.420–2.046. Two complete-flow comparisons repeat about 5.4% and 5.6% less time, below the 10% material target. Noop median regressions remain in both; the replication also flags failure median and navigation/backend observed maxima. Residency remains off by default. These are shared native macOS, one-worker engineering results; native Linux, contention and broader release gates remain open.

The [indexed-query checkpoint](compatibility/evidence/resident-indexed-checkpoint-2026-10-08.json) records 104 current core groups, Node 22 checks and 57 registry cases. A positive `nth` of one plain CSS compound now reads an existing document match from a fresh native NodeList. Shadow targets and other selector forms use the complete pinned resolver, and membership is shared only within a synchronous batch. Full predicates still run. Tests cover nested shadows, changing document/shadow indices, negative/fractional/missing indices, captures, selector functions and DOM replacement across microtasks.

An isolated 4,000-match counter case records one native query and no NodeList iteration or shadow-host reads before the predicate, compared with two queries, 8,004 iterations and 4,004 reads through the complete resolver. Those are work counters, not a CPU or speed claim. The [210-launch ordinary plan](compatibility/evidence/resident-indexed-profile-plan-2026-10-08.json) is complete and independently verified.

The [indexed-query performance checkpoint](compatibility/evidence/resident-indexed-performance-checkpoint-2026-10-08.json) passes every CPU, memory and complete-time gate across all nine sustained-load scenarios. At 128 concurrent conditions, paired Playwright/resident CPU ratios are 3.046–3.250, roughly one-third as much sampled CPU. The single-condition ratios are 1.127, 0.995 and 0.974 for quiet text, property-only and mutation-text respectively, all within budget. These are six-group observations on one shared native macOS host, with the same browser and full application work.

Two complete-flow comparisons show about 5.5% and 6.7% less time, below the 10% material target. Noop/failure median regressions remain in both; neither flags an observed-maximum regression. All 210 launches and cleanup audits pass. Residency remains off by default while complete-flow, native Linux, contention and broader release gates are open.

The [private evaluation helper checkpoint](compatibility/evidence/evaluation-helper-checkpoint-2026-10-08.json) records 104 passing core groups at 159 matching source hashes, plus Node 22 coverage. Each main-world context owns one private code helper, shared during concurrent first calls. Each user evaluation still gets a fresh codec and runs once in its original context. Tests cover Unicode source, value/error provenance, concurrent promises, cancellation during setup, document replacement, navigation without replay, and page closure. The [performance plan](compatibility/evidence/evaluation-helper-profile-plan-2026-10-08.json) includes 64 ordinary launches and four separate protocol-attribution launches.

The Linux script runs in the pinned Playwright container with `/source` mounted read-only and `/output` mounted writable. Set `FLASHWRIGHT_ENVIRONMENT_CLASS` and `FLASHWRIGHT_CONTAINER_IMAGE` accurately. An amd64 container on an arm64 Docker host is emulated and cannot satisfy the native Linux performance gate

## R4 Upstream sources

Pinned Playwright declarations supply the compatibility inventory. Selected upstream test bodies are retained unchanged under compatibility/migration-projects, with source URLs and hashes beside them. The packed migration harness now executes the three TodoMVC tests; SVGOMG remains a target for the later frame, download and file API work. Migration results are functional evidence and do not establish a performance advantage

[Third-party notices](THIRD_PARTY_NOTICES.md) identify reused sources. The Flashwright execution path uses its own Rust Chromium connection; the plain library is independent of the test runner. The separate adapter depends on a pinned, isolated Playwright Test scheduler and generic assertion infrastructure
