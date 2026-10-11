# Benchmark comparison status

Flashwright has not established performance leadership. The [five-engine checkpoint](../compatibility/evidence/broad-performance-checkpoint-2026-10-10.json) records 40 passing sampled launches after a 162-group core gate. All 926 recorded source files match commit `70dc299f`. The [complete comparison table](../benchmarks/results/broad-matrix-2026-10-10/evidence/table.md) includes every workload, preparation-inclusive totals, startup, CPU, concurrent memory, uncertainty and recorded semantic differences.

## Latest measured broad comparison

Eight rotated blocks ran on native macOS arm64 with full Chrome 148.0.7778.96. Bun 1.4.2 coordinated the run; every shared library workload used Node 22.22.0. Each library flow has three warmups and 12 measured observations per launch. Complete work includes preparation, warmup, semantic verification and cleanup; child process wall also includes imports and the sampling wrapper. Brackets below are 95% launch-clustered intervals.

| Engine | Version | Class | Startup ms | Complete ms | Child process wall ms | CPU s | Median launch peak RSS MiB | Maximum sampled RSS MiB | Failures |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| flashwright | development checkout | library-flow | 500.5 [413.2, 829.1] | 8478.8 [8317.0, 8872.5] | 9117.7 [8722.9, 9551.5] | 8.12 [7.79, 8.37] | 946.9 [942.6, 950.2] | 951.4 | 0 expected, 0 unexpected |
| playwright | 1.60.0 | library-flow | 523.2 [375.1, 579.7] | 8423.6 [8264.4, 9110.7] | 8940.3 [8715.8, 9493.2] | 8.87 [8.37, 8.95] | 930.9 [927.0, 936.2] | 937.0 | 0 expected, 0 unexpected |
| puppeteer | 25.13.0 | library-flow | 433.1 [386.2, 456.4] | 8695.8 [8409.2, 8806.2] | 8954.7 [8721.0, 9119.4] | 7.90 [7.68, 8.20] | 862.6 [853.6, 865.3] | 865.5 | 0 expected, 0 unexpected |
| cypress | 16.1.1 | runner-outcome | Not isolated | 17516.8 [16923.2, 18682.0] | 17833.5 [17297.0, 19002.1] | 25.45 [24.13, 26.00] | 1876.1 [1801.5, 1924.9] | 1932.0 | 120 expected, 0 unexpected |
| webdriverio | 10.0.2 | library-flow | 1824.4 [1670.4, 1911.3] | 53807.8 [53270.8, 55482.8] | 54073.2 [53450.5, 55783.5] | 66.86 [66.36, 69.56] | 2179.1 [2117.4, 2845.5] | 2855.2 | 0 expected, 0 unexpected |

The four library-flow rows and Cypress runner-outcome row do not perform equivalent complete work. Puppeteer and WebdriverIO retain different input counts and failure diagnostics; WebdriverIO also retains its native ChromeDriver launch policy. Cypress uses synthetic input, its proxy/runner and per-test storage reset. Its 120 intentional failures remain actual failed tests. The complete table preserves all these distinctions; the numbers do not establish an overall ranking.

This frozen source precedes matcher accessibility diagnostics in `1a49a790`. The measured failure fixture checks method/selector text, not the full error context or automatic failure document. Those newer diagnostics need a fresh measurement after their own acceptance gates. Native Linux, contention and representative matched runner suites remain unverified.

## Paired analysis of the broad blocks

[Recomputed paired results](../benchmarks/results/broad-matrix-2026-10-10-paired.json) use the same eight blocks, with each Playwright/Flashwright pair identified by its block index. The engines are not always adjacent. Values are milliseconds; ratios above 1 favor Flashwright.

| Metric | Playwright ms | Flashwright ms | Paired ratio | 95% interval |
| --- | ---: | ---: | ---: | --- |
| Complete run | 8423.648 | 8478.787 | 0.997 | 0.941–1.028 |
| Process wall | 8940.302 | 9117.717 | 1.004 | 0.940–1.022 |
| Cold browser launch | 523.215 | 500.461 | 0.946 | 0.556–1.334 |
| Noop | 0.337 | 0.318 | 1.035 | 0.740–1.587 |
| Interaction | 16.582 | 16.461 | 1.006 | 0.994–1.016 |
| Assertion | 25.554 | 10.657 | 2.423 | 2.276–2.438 |
| Navigation | 57.380 | 55.935 | 1.027 | 0.982–1.056 |
| Setup | 236.414 | 243.937 | 0.968 | 0.929–1.041 |
| Backend | 47.100 | 41.835 | 1.129 | 1.010–1.180 |
| Failure | 24.775 | 26.554 | 0.929 | 0.913–0.936 |

The complete-run estimate is unresolved: 0.997× with an interval spanning 0.941–1.028×. It fails the predeclared 10% material improvement target. Failure median latency breaches the 5% regression limit; observed maxima breach the 15% limit for interaction, setup, backend and failure. These maxima are individual observations, not population-tail estimates. Memory remains within policy. No p95/p99 claim follows from this sample count.

Setup accounts for about 44.0% of Flashwright complete time. Its delayed assertion flow is about 2.42× faster, but that gain does not produce a faster complete run. The paired CPU ratio is 1.072 with interval 1.039–1.117; sampled process-tree memory is slightly higher for Flashwright. The watchdog may miss short-lived or already-reparented processes.

The [portable manifest](../benchmarks/results/broad-matrix-2026-10-10/manifest.json) retains all 437 original files by original/exported hashes. Every numeric JSON/JSONL observation and the complete table remain unchanged. Core stdout may intentionally contain malformed protocol bytes; the exporter preserves those bytes outside exact path substitutions. The original and portable matrices pass the same recorded-source verifier. Paired analysis is byte-identical across Bun 1.4.2 and Node 22.22.0/24.15.0.

To recheck, retain or recreate the exact `70dc299f` checkout and its locked dependencies, then run from this checkout:

```sh
bun tools/broad-matrix-snapshot.mjs verify benchmarks/results/broad-matrix-2026-10-10 /absolute/path/to/recorded-checkout
bun tools/analyze-broad-pair.mjs benchmarks/results/broad-matrix-2026-10-10/evidence /absolute/path/to/recorded-checkout .cache/new-paired-analysis.json
```

The verifier deliberately uses the recorded checkout. These commands verify retained evidence; they do not verify current executable bytes or accept newer source revisions. The [export procedure](broad-matrix-export.md) describes custody and normalization.

## Earlier Bun paired baseline (`41cbdcea`)

The [measured checkpoint](../compatibility/evidence/current-performance-checkpoint-2026-10-10.json) passes all 144 core groups at 851 source hashes matching commit `41cbdcea`. The subsequent [16-launch snapshot](../benchmarks/results/current-paired-2026-10-10/summary.json) passes independent verification before and after path normalization. Both engines use Bun 1.4.2 and the same full Chrome 148.0.7778.96 executable and launch policy on the shared native Apple M3 Pro macOS host. This is one worker, seven library flows and artifacts off.

The subsequent [Download checkpoint](../compatibility/evidence/downloads-checkpoint-2026-10-10.json) passes 156 functional core groups. Those changes were not measured at that checkpoint; the newer Node22 broad comparison above includes them. The following Bun table applies to the earlier revision only. Native Linux measurements remain unverified.

Times below are milliseconds, expressed as medians of independent-launch medians. Each operation has 96 measured observations across eight launches, plus three warmups per launch. Ratios are paired Playwright/Flashwright values; above 1 favors Flashwright. Confidence intervals use the predeclared launch-clustered bootstrap. Complete runs include preparation, warmup, semantic verification and cleanup; process wall also includes runtime imports and the sampling wrapper.

| Metric | Playwright ms | Flashwright ms | Paired ratio | 95% interval |
| --- | ---: | ---: | ---: | --- |
| Complete run | 8075.777 | 7873.119 | 1.019 | 1.001–1.036 |
| Process wall (imports and wrapper included) | 8450.858 | 8311.049 | 1.014 | 0.988–1.037 |
| Cold browser launch | 378.876 | 386.064 | 0.975 | 0.941–1.143 |
| Noop | 0.244 | 0.282 | 0.874 | 0.705–1.059 |
| Interaction | 16.522 | 16.492 | 1.003 | 0.994–1.007 |
| Assertion | 25.080 | 10.401 | 2.401 | 2.349–2.513 |
| Navigation | 54.562 | 53.570 | 1.008 | 0.973–1.070 |
| Setup | 231.069 | 234.431 | 0.990 | 0.936–1.013 |
| Backend | 41.745 | 41.663 | 1.002 | 0.993–1.028 |
| Failure | 24.492 | 25.841 | 0.949 | 0.941–0.957 |

Median sampled process-tree CPU was 8.30 seconds for Playwright and 7.60 for Flashwright. Maximum sampled concurrent RSS was 944.59 MiB and 919.42 MiB respectively; the memory policy passes. These resource observations include the descendant tree, with the watchdog's documented risk of missing short-lived or reparented children.

The paired complete-run estimate is about 1.9% less elapsed time, below the configured 10% target. Noop and failure medians still breach the regression policy; no observed maximum does. All launches complete with zero unexpected failures and clean owned-process exit. There are too few independent launches for p95/p99 claims. The setup workload accounts for about 45.7% of Flashwright complete time, supporting further setup and preparation research. This snapshot does not rank the broader contender set or complete runner-suite, contention, native Linux or release gates.

The separate [four-launch instrumented profile](../benchmarks/results/current-attribution-2026-10-10/summary.json) also passes independent verification. Flashwright sends 1,048–1,049 browser commands per launch versus Playwright’s 2,189–2,280. Flashwright’s setup-phase median target-creation acknowledgements take about 75–78ms, `Page.enable` about 55–56ms, and navigation about 41–44ms. These intervals include proxy, transport and scheduling costs and can overlap; they do not isolate browser CPU. Instrumented observations are excluded from the ordinary timing table.

Recheck exported observations with `bun tools/verify-paired.mjs benchmarks/results/current-paired-2026-10-10`. The [core report and logs](../compatibility/evidence/current-core-2026-10-10/report.json) bind the measured binary, sources and browser. Original and normalized hashes are recorded in the checkpoint; numeric observations are unchanged.

## Puppeteer functional admission

The [admission checkpoint](../compatibility/evidence/competitor-admission-checkpoint-2026-10-10.json) records exact browser flags, package/dependency bytes, application outcomes, context isolation and watchdog cleanup. The [retained reports](../benchmarks/results/competitor-admission-2026-10-10/manifest.json) include all four Node passes and the failed Bun attempt, with workstation paths normalized. This run uses the existing real HTTP fixture and seven flow categories. It retains elapsed observations for diagnosis, but those observations are excluded from comparative performance acceptance. Partial reports survive unexpected failures, and a failure stops the remainder of that admission attempt.

Puppeteer uses its native locators with ordinary viewport, visibility, enabled and stability checks. ARIA selectors find buttons and the labelled input. The small text/title predicate helper uses `page.waitForFunction` with mutation polling; it is specific to these unique, plain-text fixture targets. It does not implement general Playwright assertions. These choices follow the available [locator APIs](https://pptr.dev/guides/page-interactions) and [waitForFunction API](https://pptr.dev/api/puppeteer.frame.waitforfunction).

Two differences prevent treating the complete seven-flow run as equivalent work:

- Native fill emits 126 trusted input events across 15 backend iterations; the reference fill contract expects 15. Both produce the expected saved values and backend requests, but applications can observe the different event sequence.
- The missing-element case uses Puppeteer's native visibility-selector timeout. It does not perform the same diagnostic work as a failing Playwright assertion.

The admitted Node configurations cover Chromium 148.0.7778.96 headless shell and full Chrome. The Puppeteer package version is independently pinned; this local fixture evidence is not a claim that all of its APIs support that older browser revision. Bun remains the dependency installer and harness host. The tested Puppeteer locator interaction times out when the browser workload itself runs on Bun 1.4.2; retained Node execution passes. The exact cause of that runtime-specific behavior is unresolved.

To reproduce, use Bun 1.4.2, the separately installed pinned browser and Node 22.22.0 or 24.15.0. Install the competitor in an isolated directory so it cannot change the project dependency graph:

```sh
competitor_directory="$(mktemp -d)"
cp benchmarks/competitors/puppeteer/package.json benchmarks/competitors/puppeteer/bun.lock "$competitor_directory/"
(cd "$competitor_directory" && bun install --frozen-lockfile --ignore-scripts)
export FLASHWRIGHT_COMPETITOR_DIRECTORY="$competitor_directory"
export FLASHWRIGHT_COMPETITOR_RUNTIME="$(command -v node)"
export FLASHWRIGHT_BROWSER_PATH="/absolute/path/to/pinned/chromium"
bun tools/run-competitor-admission.mjs .cache/new-competitor-admission
bun test ./tools/test-competitor-contract.mjs
```

The output directory must be new. The harness records every installed dependency file, selected browser and harness input before execution, verifies they remain unchanged, and rejects missing work, untrusted events, leaked storage or processes, altered launch flags and obsolete resource accounting. The raw reports and final admission decision are retained together.

## WebdriverIO functional admission

WebdriverIO uses its native WebDriver BiDi commands through ChromeDriver 148.0.7778.96. Separate BiDi user contexts provide cookie/localStorage isolation. Native ARIA element commands perform clicks and typing; fixture-specific text/title checks use `waitUntil` with its ordinary 500ms polling interval. The missing-element flow uses `waitForDisplayed`. These are application-outcome checks, not general Playwright assertion or actionability parity.

ChromeDriver adds automation/logging switches, disables two additional features and creates its bootstrap page. The reference `--no-startup-window` switch is removed. The [declared driver policy](../benchmarks/configurations/webdriverio-launch-policy.json) and actual launch arguments remain visible; launch-policy equivalence is explicitly false. Native typing emits 126 trusted input events over 15 saves, and failure diagnostics differ. Complete equivalent-work performance remains unmeasured.

The [WebdriverIO checkpoint](../compatibility/evidence/webdriverio-admission-checkpoint-2026-10-10.json) and [retained reports](../benchmarks/results/webdriverio-admission-2026-10-10/manifest.json) cover native protocol negotiation, browser/driver/runtime/dependency hashes, request and input counts, isolation and cleanup. Verbose ChromeDriver protocol logging is enabled for this admission audit, so timings and resource observations are diagnostic only. The large protocol logs remain private by hash; exported samples retain actual launch arguments and all numeric observations. Earlier failed probes and the Node package-metadata lookup failure remain recorded in the checkpoint.

For macOS arm64 reproduction, install `benchmarks/competitors/webdriverio/package.json` and its `bun.lock` into a new isolated directory with `bun install --frozen-lockfile --ignore-scripts`, as in the Puppeteer example. Obtain ChromeDriver 148.0.7778.96 from the matching [Chrome for Testing manifest](https://googlechromelabs.github.io/chrome-for-testing/148.0.7778.96.json), and compare its archive/executable hashes with the checkpoint. Set `FLASHWRIGHT_COMPETITOR_DIRECTORY`, `FLASHWRIGHT_BROWSER_PATH` and `FLASHWRIGHT_CHROMEDRIVER_PATH`, then run:

```sh
bun tools/run-competitor-admission.mjs .cache/new-webdriverio-admission webdriverio
```

Bun is the default workload runtime; `FLASHWRIGHT_COMPETITOR_RUNTIME` selects an absolute Node executable for compatibility checks. Supplying both browser and driver paths prevents automatic browser/driver selection, as described by WebdriverIO's [driver setup documentation](https://webdriver.io/docs/driverbinaries). Its [protocol documentation](https://webdriver.io/docs/automationProtocols) explains BiDi negotiation; the verifier rejects fallback to classic WebDriver.

With the snapshot's recorded source checkout, verify exported hashes and independently recheck every functional admission using `bun tools/verify-competitor-snapshot.mjs benchmarks/results/webdriverio-admission-2026-10-10`. This verifier intentionally rejects changed source bytes and does not confer performance acceptance.

## Cypress runner outcome admission

Cypress 16.1.1 executes 105 ordinary isolated runner tests on Bun 1.4.2, Node 22.22.0 and Node 24.15.0 with full Chrome 148.0.7778.96. Each run produces 90 passes and 15 intentional missing-element failures, with no unexpected failures or skipped tests. The failure cases remain actual runner failures. Each run makes 120 fixture document requests and 15 real backend requests, verifies cookie/local/session storage reset, and finishes with clean process cleanup.

The [checkpoint](../compatibility/evidence/cypress-admission-checkpoint-2026-10-10.json) and [retained reports](../benchmarks/results/cypress-admission-2026-10-10/manifest.json) include every test, event count, duration and resource observation. The first attempt failed in the harness's process-capture hook; that failed report is retained. Source, installed dependency, complete Cypress application bundle, browser and runtime bytes are recorded and checked before and after each run.

Default `click` and `type` dispatch untrusted events here. Cypress's native proxy, launch policy and per-test storage reset differ from the native-input, fresh-context library flows. Every case includes runner page preparation. Proposed launch options and the owned browser command are recorded separately. These are outcome-admission results; equivalent-operation admission and performance acceptance remain false. This follows Cypress's documented [event behavior](https://docs.cypress.io/app/core-concepts/interacting-with-elements), [test isolation](https://docs.cypress.io/app/core-concepts/test-isolation) and [browser launch hook](https://docs.cypress.io/api/node-events/browser-launch-api).

For macOS arm64 reproduction, copy `benchmarks/competitors/cypress/package.json` and `bun.lock` into a new isolated directory and run `bun install --frozen-lockfile --ignore-scripts`. Explicitly install the pinned Cypress binary using its CLI with an owned `CYPRESS_CACHE_FOLDER`, as described in [advanced installation](https://docs.cypress.io/app/references/advanced-installation). Set `FLASHWRIGHT_COMPETITOR_DIRECTORY` to that dependency directory, `FLASHWRIGHT_CYPRESS_BUNDLE` to its `16.1.1/Cypress.app`, and `FLASHWRIGHT_BROWSER_PATH` to full Chrome 148.0.7778.96. Run:

```sh
bun tools/run-cypress-admission.mjs .cache/new-cypress-admission
bun test ./tools/test-cypress-contract.mjs
bun tools/verify-cypress-snapshot.mjs benchmarks/results/cypress-admission-2026-10-10
bun tools/verify-competitor-snapshot.mjs benchmarks/results/cypress-admission-2026-10-10/regressions
```

`FLASHWRIGHT_COMPETITOR_RUNTIME` selects an absolute Node executable; Bun is the default. The snapshot verifier needs its recorded source checkout and checks normalized exported bytes independently. The expanded Cypress configuration stays private by hash because it contains environment-specific configuration; the public curated report preserves every test and observation. Headless shell and native Linux remain unmeasured for this Cypress class.

## Backend application functional gates

The [backend functional checkpoint](../compatibility/evidence/backend-corpus-functional-checkpoint-2026-10-11.json) records the original 62 tests from pinned `fastapi/full-stack-fastapi-template` commit `7257e606cb94eada1dca40173e2b7f99dd549bc6`, including auth setup. Test and helper bodies are unchanged. Both engines used Bun 1.4.2 and full Chrome 148.0.7778.96 on native macOS arm64, with fresh PostgreSQL 18.4, Mailpit and four FastAPI server workers.

| Engine / execution class | 1 test worker | 4 test workers |
| --- | --- | --- |
| Playwright 1.60.0 / installed reference functional check | 62 passed; no skips or retries | 62 passed; no skips or retries |
| Flashwright / development alias functional diagnosis only | 62 passed; no skips or retries | 62 passed; no skips or retries |
| Flashwright / selected packed alias, installed release-build driver | 62 passed; no skips or retries | 62 passed; no skips or retries |

The first candidate run had 61 passes and one navigation failure in the reset-password link flow. Its original evidence remains retained. A navigation repair prevented an outgoing same-document event from interrupting `page.goto('/login')`; subsequent fresh runs passed. The failed development-diagnosis run used a release driver; its repaired development-alias passes used a development/debug driver. These functional cells cannot supply a speed comparison. Successful runs retained unchanged bound inputs, clean observed process shutdown and temporary-state removal. Reported overlap does not establish complete owned worker/resource coverage.

The development-alias cells are single functional launches using then-unmerged request source. The reference cells used installed Playwright 1.60.0. These earlier functional cells do not establish packed installation, shipped public request support, release acceptance or comparative performance. Raw evidence remains private; the checkpoint publishes identities, hashes, outcomes and limits. All functional runs used trace/video/screenshots off. The draft final-goal backend policy still selects `on-first-retry` tracing and requires fresh admission and measurements before sealing. Historical numeric tables above are unchanged. Native Linux remains unverified.

The later [packed backend checkpoint](../compatibility/evidence/backend-corpus-packed-checkpoint-2026-10-11.json) independently matches all original 62 test IDs, titles, files and lines at both worker counts. One fresh packed alias test consumer retained 118 unchanged frontend files and a declared test-only `package.json` adaptation. It used the actual common prebuilt frontend, fresh PostgreSQL 18.4/Mailpit 1.31.4 state, four FastAPI server workers and the installed release-build driver. Two driver spawn/clean-close pairs at one worker and five at four workers were retained; all 7,724 frozen files and nine exact tree inventories stayed unchanged. This admits the selected packed backend functionality only. Current full-core, native Linux, release publication and performance acceptance remain pending. Original failed evidence and historical numeric tables remain unchanged.

## Remaining comparison work

Actual runner startup, retries, hooks, artifacts and parallel execution still need representative suite comparisons across the declared contenders.

To reproduce the historical comparisons, verify the recorded Flashwright binary and sources, run matched independent launches with rotated execution order, and apply the [predeclared statistical and regression policy](../benchmarks/configurations/baseline.json). Include complete preparation and cleanup, uncertainty, CPU/concurrent memory, unexpected failures and contention. A functional pass, one favorable run or a different input contract does not satisfy that gate.

Current goal acceptance follows the [draft final-goal contract](../benchmarks/configurations/final-goal.json). Its nine scenarios each have two worker cells; all 18 cells remain unmeasured for final admission, and the contract remains unsealed. Native Linux remains unverified.

The experimental [broad matrix coordinator](../benchmarks/broad-matrix.mjs) prepares eight independent launches for every declared contender. Inspect its requirements without starting a browser:

```sh
bun benchmarks/broad-matrix.mjs --plan
bun benchmarks/broad-matrix.mjs --plan --sample-library
bun test ./tools/test-broad-matrix.mjs
```

Its default collection mode repeats the existing admission probes. Puppeteer and WebdriverIO retain per-iteration report writes and an extra isolation probe; WebdriverIO also retains verbose protocol logging. Cypress measures its ordinary isolated runner tests and records intentional failures. These are diagnostic engineering observations, excluded from broad equivalent-work speed claims. Representative matched runner suites remain necessary for a production comparison.

Puppeteer and WebdriverIO also have a separate library sampling mode. Append an independent-launch index to the admission wrapper, for example `bun tools/run-competitor-admission.mjs .cache/new-puppeteer-sample puppeteer 3`. It rotates the workload order using the same index as the reference, preserves native readiness and all outcome checks, omits the extra isolation probe, and writes the retained report in the parent after the child exits. Browser/driver binary verification also runs in the parent. WebdriverIO uses warning-level ChromeDriver logs and observes the owned browser process's launch command once during startup. These startup observations and final workload telemetry remain part of complete work. Ordinary admission without an index retains its original diagnostic behavior.

A sampling receipt reports `samplingOutcomesPassed`, while `functionalAdmissionPassed` and `performanceAccepted` remain false. Separate current-source isolation admission is still required. The broad coordinator's `--sample-library` mode runs and retains that admission first for both engines, then binds it to every sample's source, package, runtime and binary identities. Failed admission stops collection before measurements. Admission attempts remain in `admission-progress.json`; their durations and resources are excluded from the sampling table. Incomplete or interrupted sampling runs retain stdout/stderr and watchdog evidence even when no complete JSON report can be parsed.

Independently recheck a sampling run using `bun tools/verify-competitor-sampling.mjs RETAINED_DIRECTORY`. It verifies original source hashes, the retained-file inventory, binary identity records, raw stdout, workload order, outcomes and process cleanup. For WebdriverIO it also checks that the captured browser PID belongs to the watchdog's observed process tree and that the driver log contains no info/debug protocol stream. This verification does not establish a comparative performance result.

For a coordinated run, set `FLASHWRIGHT_BROAD_RUNTIME` to one absolute runtime executable for every measured child, and supply `FLASHWRIGHT_VERIFICATION_REPORT`, `FLASHWRIGHT_DRIVER_PATH`, and `FLASHWRIGHT_BROWSER_PATH` for a passed core report with exactly matching sources, runtime, browser and driver. Install the pinned competitors in separate directories and set `FLASHWRIGHT_PUPPETEER_DIRECTORY`, `FLASHWRIGHT_WEBDRIVERIO_DIRECTORY`, `FLASHWRIGHT_CYPRESS_DIRECTORY`, `FLASHWRIGHT_CHROMEDRIVER_PATH`, and `FLASHWRIGHT_CYPRESS_BUNDLE`. The coordinator itself uses Bun. The initial Cypress adapter requires macOS; native Linux remains unverified.

Only after coordinating exclusive measurement time, run `FLASHWRIGHT_BROAD_RUN=1 bun benchmarks/broad-matrix.mjs --sample-library` for library sampling, or omit the flag for repeated diagnostic admission. Both retain every attempted launch and any failures in a new result directory. Engine order rotates, with Playwright/Flashwright order alternating. All process-wall cells use the common watchdog's child interval, so parent dependency verification does not inflate competitor times. A complete admitted run produces `summary.json` and `table.md`, including all seven workloads, preparation-inclusive totals, launch-clustered uncertainty, sampled CPU and concurrent memory, intentional failures, instrumentation and semantic differences. Cypress startup and preparation-inclusive workload intervals remain explicitly unisolated.

Recheck a collected run using `bun tools/verify-broad-matrix.mjs RETAINED_DIRECTORY` from its recorded source checkout. The verifier checks retained hashes, core logs, runtime/dependency identities, every original semantic admission and the recomputed statistics/table. The retained 40-launch matrix above uses its library sampling mode; it does not establish broad performance leadership. Raw outputs can contain workstation paths and must be normalized and reverified before public retention under S19.i.

## Native runner fixture suite

`bun tools/run-runner-suite.mjs NEW_DIRECTORY playwright|flashwright [LAUNCH_INDEX]` executes one common test source through the selected engine's actual runner. Build the checkout's packages and driver first; set `FLASHWRIGHT_BROWSER_PATH` and `FLASHWRIGHT_DRIVER_PATH`. Bun is the default runtime; `FLASHWRIGHT_RUNNER_RUNTIME` selects an absolute Node executable for compatibility checks. Every copied test body must match the checked-in source hash. The generated import adapter and configuration are recorded separately and checked for changes during execution.

The suite contains 105 ordinary tests with one worker, fresh context/page fixtures, no retries, and trace/video/screenshots off. It covers the seven baseline workload groups, rotates their order by launch index, verifies cookie/local/session storage isolation, and records trusted input and backend request counts. Fifteen missing-element assertions remain actual failed tests with runner exit code 1. They are expected by the outer harness; they are not caught inside tests or converted with `test.fail`. Normal failed-worker restarts and resulting browser launches remain in the complete work and resource totals. Default failure diagnostic attachments are retained and listed explicitly.

The pinned reference emits an `error-context` Markdown snapshot for each of the 15 failed tests. Initial native runner probes produced none for Flashwright. With default failure documents implemented, a [retained 25 ms pair](../compatibility/evidence/runner-diagnostic-stress-checkpoint-2026-10-10.json) produced all 15 documents in both engines, but one Flashwright case had no retained predicate observation and used a later private-AI page snapshot. Its static page content and source linkage were useful; they could not establish equivalent predicate work. The planned matrix stopped after that pair, without performance acceptance.

The complete-runner profile now uses `benchmarks/configurations/runner-suite.json` with a 250 ms failure budget shared by both engines. Every cold context, page and assertion preparation step remains inside complete-suite time. The 25 ms baseline remains unchanged as a separate stress class. Admission requires actual content: every failure must retain its original predicate observation, selector/method/timeout, missing-element result, original user call site, complete common source frame and exact fixture accessibility tree. It rejects later fallback, omissions, borrowed attachments and missing observations. Public diagnostic wording and repeated private call-log lines may differ under SPECS S4.g. These checks are specific to the controlled fixture and do not establish general artifact parity.

The raw JSON reporter retains per-test durations, statuses, errors, annotations and attachments. An afterEach annotation records the operation interval, isolation, native input, viewport, focus, browser version and worker identity. That interval includes the transition into afterEach; complete work also includes fixtures, diagnostic reporting, worker restarts and cleanup. The verifier checks all 105 test identities, all actual failures, original browser launch flags, worker process ownership and watchdog cleanup. The native backend guard remains enabled in Flashwright's configuration and workers. When runner stderr is both forwarded and retained in JSON, both copies must agree before launches are counted. Stderr chunks are reassembled without inserting bytes; terminal control sequences are removed only while parsing, with the raw streams retained. Collection explicitly disables terminal progress rendering.

Run `bun test ./tools/test-runner-suite-contract.mjs ./tools/test-runner-suite-diagnostics.mjs` for corruption checks and `bun tools/verify-runner-suite.mjs RETAINED_DIRECTORY` for independent verification against the recorded source, installed packages, binary identities and actual diagnostic content. The supplemental `diagnosticAdmission` receipt preserves the original conservative outcome-only fields; `performanceAccepted` remains false. This is a controlled fixture suite, not the representative application corpus or a matched comparison with Cypress's synthetic input and per-test reset. Runner startup attribution, representative applications, retries/artifacts/concurrency comparisons and native Linux remain open.


The [retained complete-runner matrix](../benchmarks/results/runner-matrix-2026-10-10/table.md) contains all eight alternating pairs, 840 tests and 120 original failure documents per engine. Every run passed outcome, diagnostic-content and process-cleanup admission. It uses the frozen `dbc58afe` harness, Bun 1.4.2 and full Chromium 148.0.7778.96, with the exact driver from the 179-group core checkpoint. The reviewed harness changes did not change the engine, library, runner or common workload source. This is a separate class from the five-engine library-flow table.

| Complete native runner measurement | Playwright | Flashwright |
| --- | ---: | ---: |
| Median complete suite time | 47.223 s | 49.306 s |
| Median observed process-tree CPU | 52.560 s | 53.535 s |
| Median sampled concurrent peak RSS | 1077.742 MiB | 1105.758 MiB |
| Actual tests across all launches | 840 | 840 |
| Original failure documents admitted | 120 | 120 |

The median paired complete-time ratio is 0.9573 (Playwright / Flashwright), with a 95% launch-paired interval of 0.8263–0.9692. The material-improvement and timing-regression gates fail. The largest observed concurrent RSS grows by 8.11%, within the 10% memory limit. Retain the slower late launches; no observation was removed or rerun. These are descriptive measurements: the agent created an export workspace during candidate launch 1, potentially competing for CPU and filesystem resources. That recorded overlap independently prevents performance acceptance. The report preserves this limitation alongside the complete observations, rather than treating matching test outcomes as a speed result.

The [portable manifest](../benchmarks/results/runner-matrix-2026-10-10/manifest.json) retains original and normalized byte hashes. Export normalizes declared environment paths, the private workspace-operation identifier, reporter stream chunk encoding and affected artifact hash links. Reporter chunks retain their count and joined content except approved path replacements; original chunk boundaries and encoding remain bound by the original file hashes. Source, dependency and executable identities and numeric observations remain unchanged. The independent portable verifier recomputes every outcome, original diagnostic and matrix decision from the retained reports and documents. It verifies historical custody, not the current bytes of installed dependencies or executables.

```sh
bun tools/verify-runner-matrix-snapshot.mjs benchmarks/results/runner-matrix-2026-10-10
bun test ./tools/test-runner-matrix-contract.mjs ./tools/test-runner-matrix-snapshot.mjs
```
