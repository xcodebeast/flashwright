# Benchmark comparison status

Flashwright has not established performance leadership. The current broad comparison is incomplete. The [declared contender set](../benchmarks/configurations/competitors.json) includes the compatibility reference, direct Chrome automation, an integrated browser runner and the WebDriver/BiDi ecosystem. Versions are pinned; inclusion is not a speed ranking.

| Engine | Pinned package | Library-flow admission | Runner-suite measurement | Current broad performance result |
| --- | --- | --- | --- | --- |
| Flashwright | Development checkout | Historical verified slices; fresh source/driver acceptance required before new timing | Pending broader migration corpus | Not established |
| Playwright | @playwright/test 1.60.0 | Existing seven-flow matched baseline | Pending broader comparison | Historical paired profiles only |
| Puppeteer | puppeteer-core 25.13.0 | Seven functional flows; five match the checked reference outcomes, with explicit backend/failure differences | No bundled test runner in this comparison class | Not measured |
| Cypress | cypress 16.1.1 | Separate runner/event model requires its own adapter | Not measured | Not measured |
| WebdriverIO | webdriverio 10.0.2 | Adapter and negotiated protocol admission pending | Not measured | Not measured |

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

## Remaining comparison work

Admit Cypress and WebdriverIO using their native APIs, recording differences instead of hiding them behind the Playwright adapter. Cypress documents its [event dispatch behavior](https://docs.cypress.io/app/core-concepts/interacting-with-elements); WebdriverIO documents its [protocol selection](https://webdriver.io/docs/automationProtocols). Actual runner startup, retries, hooks, artifacts and parallel execution need suite-level cases.

Before publishing comparisons, verify the current Flashwright binary and sources, run matched independent launches with rotated execution order, and apply the [predeclared statistical and regression policy](../benchmarks/configurations/baseline.json). Include complete preparation and cleanup, uncertainty, CPU/concurrent memory, unexpected failures and contention. A functional pass, one favorable run or a different input contract does not satisfy that gate.
