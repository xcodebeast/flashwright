# Benchmark comparison status

Flashwright has not established performance leadership. The current broad comparison is incomplete. The [declared contender set](../benchmarks/configurations/competitors.json) includes the compatibility reference, direct Chrome automation, an integrated browser runner and the WebDriver/BiDi ecosystem. Versions are pinned; inclusion is not a speed ranking.

| Engine | Pinned package | Library-flow admission | Runner-suite measurement | Current broad performance result |
| --- | --- | --- | --- | --- |
| Flashwright | Development checkout | Historical verified slices; fresh source/driver acceptance required before new timing | Pending broader migration corpus | Not established |
| Playwright | @playwright/test 1.60.0 | Existing seven-flow matched baseline | Pending broader comparison | Historical paired profiles only |
| Puppeteer | puppeteer-core 25.13.0 | Seven functional flows; five match the checked reference outcomes, with explicit backend/failure differences | No bundled test runner in this comparison class | Not measured |
| Cypress | cypress 16.1.1 | Default synthetic input and runner isolation are a separate class | 105 outcome-admission tests on each of Bun/Node 22/24; 15 intentional failures per run | Not measured |
| WebdriverIO | webdriverio 10.0.2 | Seven functional flows on Bun/Node 22/24 and both Chromium variants; launch/input/failure differences | Not measured | Not measured |

Startup, complete-suite time, action/assertion latency, CPU, concurrent memory and uncertainty remain unmeasured for the current broad matrix. Earlier Playwright/Flashwright observations retain their original source, browser, runtime and workload scope; see the [benchmark history](../README.md#r3-browser-baselines). They cannot establish a ranking against the additional contenders.

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
