# Cross-framework benchmark

The same 24 tests, run by 9 browser testing tools on the same machine and the same browser. Each number is the wall-clock time of the complete test command, from launch to exit, median of 15 runs; a run counts only when the tool exits cleanly with all 24 tests passed.

## The tests

Playwright's TodoMVC example suite (`bench/apps/todomvc`, 23 tests and an empty seed test) against the TodoMVC React app, served from a local HTTP server. `scenarios.mjs` describes every test once, as framework-neutral steps in the original order of actions and assertions; each tool's `adapter.mjs` turns them into idiomatic code for that tool, and the generated tests are checked in under `<tool>/tests` so they can be read and reviewed. Every port uses the same CSS selectors (Playwright and Flashwright included, which in their own example use the slower role locators) and exact text matches.

Two layouts:

- **grouped** (`LAYOUT=grouped`): each feature's tests in one file, 7 files, as most hand-written suites are organized.
- **files** (default): one test per file, 24 files, the layout of Playwright's example. Tools that pay a cost per spec file (bundling in Cypress, a worker process or a new browser session per file in WebdriverIO, Selenium and Nightwatch) do worse here.

## Setup

| Tool | Versions | Runner | Waiting | Isolation between tests | Parallel |
| --- | --- | --- | --- | --- | --- |
| Flashwright | flashwright-test 1.64.1-flashwright.11 | its own | auto-waiting actions and assertions | new tab in a reset context (its default), warm session off as in CI | `--workers` |
| Playwright | @playwright/test 1.64.1 | its own | auto-waiting actions and assertions | new browser context | `--workers` |
| Cypress | cypress 16.2.1 | its own | retry-ability (`should`) | `testIsolation` (default) | one spec at a time: parallel runs need Cypress Cloud |
| WebdriverIO | webdriverio, @wdio/cli 10.1.0, Mocha framework | its own | auto-waiting `$()` and expect-webdriverio | one session per spec file (default); tests sharing a file navigate, clear localStorage and reload | `maxInstances` |
| Selenium | selenium-webdriver 4.52.0, Mocha 12.0.3 | Mocha | explicit `driver.wait(until…)` | one driver per spec file; tests sharing a file navigate, clear localStorage and reload | `mocha --parallel --jobs` |
| Puppeteer | puppeteer 25.16.0, Jest 30.5.2, jest-puppeteer 11.0.0 | Jest | Locator API, `waitForSelector`, `waitForFunction` | new incognito context per test (`jestPuppeteer.resetBrowser()` where a file holds several tests) | `--maxWorkers` |
| TestCafe | testcafe 3.7.7 | its own | Selector and `t.expect` auto-wait | per test (default) | `-c` |
| Nightwatch | nightwatch 3.16.0 | its own | element commands and `expect` retries | one session per spec file (default); tests sharing a file navigate, clear localStorage and reload | `test_workers` |
| Bun | bun 1.4.4, `Bun.WebView` | `bun test` | `Bun.WebView` has no assertions or text locators: a small helper file (`tests/helpers.ts`) waits for conditions in the page | new view per test; views of a process share storage, so a test that finds todos clears them and reloads | `--parallel` |

Common to every tool:

- **Browser:** Chrome for Testing 156.0.8078.4 (Playwright's Chromium 1248 build, full binary), headless (new headless), 1280×720 (TestCafe: its headless default, 1280×800). The WebDriver tools share ChromeDriver 156.0.8078.80; nothing downloads a browser or driver.
- **No fixed sleeps** anywhere, no retries, no screenshots, videos or traces, quiet reporters (`dot` where available), telemetry off where a switch exists, `CI=1`.
- **Each tool's recommended waiting and its default isolation.** Settings that only remove artificial delays are applied, for example Cypress's `keystrokeDelay: 0`.

Differences worth knowing:

- Cypress cannot hover: the test that checks the delete button appears on hover asserts that it exists and clicks it with `{ force: true }`, as Cypress's documentation recommends.
- WebDriver's element clear blurs the field, which ends TodoMVC's edit mode, so WebdriverIO, Selenium and Nightwatch replace an edited title with Ctrl+A and typing. Selenium clicks TodoMVC's `opacity: 0` checkboxes once they are present and enabled, since it considers them not displayed.
- WebdriverIO 10 enables WebDriver BiDi by default. `WDIO_CLASSIC=1` sets `wdio:enforceWebDriverClassic`: about 8% faster in the files layout, 5% grouped. The published runs keep the default.

## Run

```bash
npm install --prefix bench/competitors/<tool>   # for each tool directory, and bench/competitors/chromedriver
npx playwright install chromium                # the shared browser
node bench/competitors/run.mjs 1 15            # <workers> <iterations> [tool,...]; LAYOUT=grouped for the grouped layout
sh bench/competitors/run-all.sh 15             # both layouts with 1 and 4 workers
node bench/competitors/chart.mjs <grouped-w1.json> <grouped-w4.json>
```

npm blocks install scripts by default from version 12: Cypress needs its binary (`npx cypress install`, with `CYPRESS_CACHE_FOLDER=bench/competitors/cypress/node_modules/.cypress-cache`). `run.mjs` regenerates the tests before it runs them and writes its results to `workbench/competitors/`. `BENCH_VERBOSE=1` prints the output of failed runs.

Found a setting that makes a tool faster, or a port that isn't how its users would write it? Open an issue or a pull request: the point is a fair comparison.
