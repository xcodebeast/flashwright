# Benchmarks

[Back to the README](../README.md)

## Compared to other frameworks

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/competitors-dark.svg">
  <img alt="The same 24 TodoMVC tests in 9 frameworks. With 1 worker: Flashwright 2.41 s, Bun test with Bun.WebView 4.39 s, Playwright 4.63 s, Selenium 5.48 s, Puppeteer 6.29 s, Nightwatch 6.45 s, WebdriverIO 10.57 s, Cypress 17.29 s, TestCafe 22.55 s. With 4 workers: Flashwright 1.54 s, Selenium 2.77 s, Bun 2.80 s, Puppeteer 2.98 s, Playwright 3.12 s, Nightwatch 3.38 s, WebdriverIO 4.91 s, TestCafe 9.28 s, Cypress 17.37 s." src="media/competitors.svg">
</picture>

Playwright's TodoMVC example suite, ported to each tool from one shared description of its 24 tests, so every tool runs the same actions and assertions with the same CSS selectors. Every tool drives the same Chromium 156 on the same machine with its own recommended waits (no fixed sleeps) and its default isolation between tests, and a run counts only when all 24 tests pass. Each number is the whole test command, median of 15 runs.

File layout matters too. Cypress bundles each spec, and WebdriverIO, Selenium and Nightwatch start a browser session per file. That adds up when every test has its own file, which is how Playwright's example is laid out:

| Tool | Grouped, 1 worker | Grouped, 4 workers | One test per file, 1 worker | One test per file, 4 workers |
| --- | ---: | ---: | ---: | ---: |
| **Flashwright** | **2.41 s** | **1.54 s** | **2.41 s** | **1.47 s** |
| Bun test + Bun.WebView | 4.39 s | 2.80 s | 4.41 s | 3.99 s |
| Playwright | 4.63 s | 3.12 s | 4.70 s | 2.92 s |
| Selenium + Mocha | 5.48 s | 2.77 s | 10.27 s | 4.81 s |
| Puppeteer + Jest | 6.29 s | 2.98 s | 6.14 s | 2.77 s |
| Nightwatch | 6.45 s | 3.38 s | 11.48 s | 5.44 s |
| WebdriverIO | 10.57 s | 4.91 s | 23.67 s | 9.21 s |
| TestCafe | 22.55 s | 9.28 s | 22.61 s | 9.32 s |
| Cypress | 17.29 s | 17.37 s¹ | 38.44 s | 38.41 s¹ |

<sub>¹ Cypress runs one spec file at a time: parallel runs need Cypress Cloud. Versions: Flashwright 1.64.1-flashwright.8, Playwright 1.64.1, Cypress 16.2.1, WebdriverIO 10.1.0, selenium-webdriver 4.52.0, Puppeteer 25.16.0, TestCafe 3.7.7, Nightwatch 3.16.0, Bun 1.4.4. `Bun.WebView` is an experimental browser API without assertions or text locators; its port waits with a small helper. Bun failed 1 of its 60 runs (not counted). Setup, every port and how to reproduce: [bench/competitors](../bench/competitors). Found a faster setting for a tool, or a port its users wouldn't write that way? Issues and pull requests are welcome.</sub>

## Compared to Playwright

![Bar chart: wall-clock time of 18 scenarios, Playwright vs Flashwright; Flashwright is 2.04× to 4.01× faster in each](media/benchmarks.svg)

Each bar is the complete `test` command, from launch to exit, median of 15 alternating runs on the same machine (6 CPUs, Linux), with Chromium's headless shell. Flashwright runs with its defaults apart from the [warm session](agents.md#warm-session), which is off, as in CI; nothing in the test code changes. The TodoMVC and SVGOMG suites are Playwright's own examples, the shop is a small single-page app with a sign-in setup project and 40 ms API latency, the admin app is a page of 8,500 elements whose 19 tests find them by role, label and text, and the other rows are 15-test files that each exercise one thing. Reproduce with `node bench/matrix.mjs 15`.

### Full results

| Scenario | Tests | Workers | Playwright | Flashwright | Speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| TodoMVC example suite | 24 | 1 | 3670 ms | 1011 ms | 3.63× |
| TodoMVC example suite | 24 | 4 | 1812 ms | 734 ms | 2.47× |
| SVGOMG example suite | 6 | 1 | 1738 ms | 511 ms | 3.40× |
| SVGOMG example suite | 6 | 4 | 1253 ms | 498 ms | 2.52× |
| Shop app (setup project, 40 ms API latency) | 18 | 1 | 6297 ms | 2967 ms | 2.12× |
| Shop app | 18 | 4 | 2599 ms | 1194 ms | 2.18× |
| Admin app (8,500 elements, role, label and text locators) | 19 | 1 | 6805 ms | 3031 ms | 2.25× |
| Admin app | 19 | 4 | 2699 ms | 1320 ms | 2.04× |
| Trivial tests | 15 | 1 | 1024 ms | 341 ms | 3.00× |
| Click + assertion | 15 | 1 | 1611 ms | 402 ms | 4.01× |
| Assertion on a delayed update | 15 | 1 | 1191 ms | 473 ms | 2.52× |
| Navigation | 15 | 1 | 1266 ms | 415 ms | 3.05× |
| Fixture setup only | 15 | 1 | 1170 ms | 351 ms | 3.33× |
| Form submit to a backend (20 ms API) | 15 | 1 | 1983 ms | 729 ms | 2.72× |
| `toHaveScreenshot()` against a baseline | 15 | 1 | 2333 ms | 963 ms | 2.42× |
| `page.screenshot()` to a file | 15 | 1 | 1915 ms | 765 ms | 2.50× |
| Suite with real failures (every third test) | 15 | 1 | 4334 ms | 1154 ms | 3.76× |
| Expected failures (250 ms timeout each) | 15 | 1 | 4757 ms | 1498 ms | 3.18× |
| A single test, as an agent re-runs it | 1 | 1 | 593 ms | 184 ms | 3.22× |
| A single TodoMVC test | 1 | 1 | 666 ms | 240 ms | 2.77× |

The one-file scenarios run in a single worker whatever the setting, so their 4-worker runs (2.49×–4.16×) match the ones above.

Some of that time belongs to the app: explicit delays and server responses still take as long as they take. Subtract those waits, and Flashwright's remaining overhead is 3.0×–4.5× lower than Playwright's:

| Scenario | Workers | The application's waits | Playwright adds | Flashwright adds | |
| --- | ---: | ---: | ---: | ---: | ---: |
| Form submit to a backend | 1 | 15 × 20 ms | 1683 ms | 429 ms | 3.92× |
| Assertion on a delayed update | 1 | 15 × 8 ms | 1071 ms | 353 ms | 3.03× |
| Shop app | 1 | ~2.1 s of API time | 4181 ms | 924 ms | 4.52× |
| Shop app | 4 | ~1.16 s / ~0.83 s of API time | 1435 ms | 361 ms | 3.98× |
