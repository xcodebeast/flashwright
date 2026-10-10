# Benchmark comparison status

Flashwright has not established performance leadership. The current broad comparison is incomplete. The [declared contender set](../benchmarks/configurations/competitors.json) includes the compatibility reference, direct Chrome automation, an integrated browser runner and the WebDriver/BiDi ecosystem. Versions are pinned; inclusion is not a speed ranking.

| Engine | Pinned package | Library-flow admission | Runner-suite measurement | Current broad performance result |
| --- | --- | --- | --- | --- |
| Flashwright | Development checkout | 156 functional core groups; earlier measured seven-flow profile | Pending broader migration corpus | Not established |
| Playwright | @playwright/test 1.60.0 | Existing seven-flow matched baseline | Pending broader comparison | Current seven-flow paired profile below |
| Puppeteer | puppeteer-core 25.13.0 | Seven functional flows; five match the checked reference outcomes, with explicit backend/failure differences | No bundled test runner in this comparison class | Not measured |
| Cypress | cypress 16.1.1 | Default synthetic input and runner isolation are a separate class | 105 outcome-admission tests on each of Bun/Node 22/24; 15 intentional failures per run | Not measured |
| WebdriverIO | webdriverio 10.0.2 | Seven functional flows on Bun/Node 22/24 and both Chromium variants; launch/input/failure differences | Not measured | Not measured |

Startup, complete-suite time, action/assertion latency, CPU, concurrent memory and uncertainty remain unmeasured for the current broad matrix. Earlier Playwright/Flashwright observations retain their original source, browser, runtime and workload scope; see the [benchmark history](../README.md#r3-browser-baselines). They cannot establish a ranking against the additional contenders.

## Latest measured Playwright comparison

The [measured checkpoint](../compatibility/evidence/current-performance-checkpoint-2026-10-10.json) passes all 144 core groups at 851 source hashes matching commit `41cbdcea`. The subsequent [16-launch snapshot](../benchmarks/results/current-paired-2026-10-10/summary.json) passes independent verification before and after path normalization. Both engines use Bun 1.4.2 and the same full Chrome 148.0.7778.96 executable and launch policy on the shared native Apple M3 Pro macOS host. This is one worker, seven library flows and artifacts off.

The later [Download checkpoint](../compatibility/evidence/downloads-checkpoint-2026-10-10.json) passes 156 functional core groups. Selector actions, FrameLocator, downloads and the accompanying trace/lifecycle changes have not been measured in a fresh matched performance run. The table below applies to the earlier revision only. Native Linux measurements remain unverified.

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

## Remaining comparison work

Actual runner startup, retries, hooks, artifacts and parallel execution still need representative suite comparisons across the declared contenders.

Before publishing comparisons, verify the current Flashwright binary and sources, run matched independent launches with rotated execution order, and apply the [predeclared statistical and regression policy](../benchmarks/configurations/baseline.json). Include complete preparation and cleanup, uncertainty, CPU/concurrent memory, unexpected failures and contention. A functional pass, one favorable run or a different input contract does not satisfy that gate.

The experimental [broad matrix coordinator](../benchmarks/broad-matrix.mjs) prepares eight independent launches for every declared contender. Inspect its requirements without starting a browser:

```sh
bun benchmarks/broad-matrix.mjs --plan
bun test ./tools/test-broad-matrix.mjs
```

Its first collection mode repeats the existing admission probes. Puppeteer and WebdriverIO retain per-iteration report writes and an extra isolation probe; WebdriverIO also retains verbose protocol logging. Cypress measures its ordinary isolated runner tests and records intentional failures. These are diagnostic engineering observations, excluded from broad equivalent-work speed claims. A production comparison still needs uninstrumented competitor sampling and representative matched runner suites.

For a coordinated run, set `FLASHWRIGHT_BROAD_RUNTIME` to one absolute runtime executable for every measured child, and supply `FLASHWRIGHT_VERIFICATION_REPORT`, `FLASHWRIGHT_DRIVER_PATH`, and `FLASHWRIGHT_BROWSER_PATH` for a passed core report with exactly matching sources, runtime, browser and driver. Install the pinned competitors in separate directories and set `FLASHWRIGHT_PUPPETEER_DIRECTORY`, `FLASHWRIGHT_WEBDRIVERIO_DIRECTORY`, `FLASHWRIGHT_CYPRESS_DIRECTORY`, `FLASHWRIGHT_CHROMEDRIVER_PATH`, and `FLASHWRIGHT_CYPRESS_BUNDLE`. The coordinator itself uses Bun. The initial Cypress adapter requires macOS; native Linux remains unverified.

Only after coordinating exclusive measurement time, run `FLASHWRIGHT_BROAD_RUN=1 bun benchmarks/broad-matrix.mjs`. It retains every attempted launch and any failures in a new result directory. Engine order rotates, with Playwright/Flashwright order alternating. All process-wall cells use the common watchdog's child interval, so parent dependency verification does not inflate competitor times. A complete admitted run produces `summary.json` and `table.md`, including all seven workloads, preparation-inclusive totals, launch-clustered uncertainty, sampled CPU and concurrent memory, intentional failures, instrumentation and semantic differences. Cypress startup and preparation-inclusive workload intervals remain explicitly unisolated.

Recheck a collected run using `bun tools/verify-broad-matrix.mjs RETAINED_DIRECTORY` from its recorded source checkout. The verifier checks retained hashes, core logs, runtime/dependency identities, every original semantic admission and the recomputed statistics/table. No broad matrix has yet been run with this coordinator. Raw outputs can contain workstation paths and must be normalized and reverified before public retention under S19.i.
