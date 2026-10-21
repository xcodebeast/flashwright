# Flashwright

Flashwright is a faster [Playwright](https://playwright.dev). It is a fork of Playwright v1.64.1 with the same API, test runner, reporters, trace viewer and browsers, changed only where time is spent. Existing Playwright suites run unmodified and finish in about half the time.

The fork follows upstream closely: Playwright's own test suites are the regression bar, and every Flashwright change is a small, documented patch that can be carried to new Playwright releases.

## How much faster

Complete `test` command wall-clock, Flashwright vs stock `@playwright/test` 1.64.1, same machine (6 CPUs), same Chromium (headless shell 156), median of 5 alternating runs. Reproduce with `node bench/matrix.mjs 5 1,4`.

| Scenario | Tests | Workers | Playwright | Flashwright | Speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| TodoMVC (upstream example suite) | 24 | 1 | 3830 ms | 1653 ms | 2.32× |
| TodoMVC | 24 | 4 | 1947 ms | 1020 ms | 1.91× |
| SVGOMG (upstream example suite) | 6 | 1 | 1765 ms | 1065 ms | 1.66× |
| SVGOMG | 6 | 4 | 1332 ms | 891 ms | 1.49× |
| Shop app (login setup project, 40 ms API latency) | 18 | 1 | 6349 ms | 3434 ms | 1.85× |
| Shop app | 18 | 4 | 2739 ms | 1499 ms | 1.83× |
| Trivial test | 15 | 1 | 1073 ms | 424 ms | 2.53× |
| Click + assertion | 15 | 1 | 1682 ms | 720 ms | 2.34× |
| Assertion on a delayed update | 15 | 1 | 1256 ms | 551 ms | 2.28× |
| Navigation | 15 | 1 | 1342 ms | 547 ms | 2.45× |
| Fixture setup only | 15 | 1 | 1233 ms | 487 ms | 2.53× |
| Form submit to a backend (20 ms API) | 15 | 1 | 2067 ms | 1003 ms | 2.06× |
| `toHaveScreenshot()` against a baseline | 15 | 1 | 2432 ms | 1070 ms | 2.27× |
| `page.screenshot()` to a file | 15 | 1 | 1954 ms | 915 ms | 2.14× |
| Suite with real failures (every third test) | 15 | 1 | 4482 ms | 2465 ms | 1.82× |
| Expected failures (250 ms timeout each) | 15 | 1 | 4804 ms | 4185 ms | 1.15× |

The single-file workloads run in one worker regardless of the worker setting; their 4-worker numbers match the 1-worker ones. Some scenarios are bounded by time the tests themselves ask for: 15 × 250 ms of assertion timeouts, the shop's ~2.1 s of API latency and debounce timers, SVGOMG's own SVG optimization work. Flashwright removes most of the framework time around them.

## What changed

Each item keeps Playwright's observable behavior; the differences that remain are listed below.

- **Warm renderers through context recycling.** Recompiling the application's JavaScript in a fresh renderer for every test dominates many suites (47 ms of a 60 ms TodoMVC setup). Flashwright keeps one browser context per worker and gives each test a brand-new tab in it, opened next to the old one so it lands in the already-warm renderer. Between tests it resets everything a test can change: context options, permissions, cookies, every visited origin's storage (local, session, IndexedDB, Cache Storage, service workers, ...), the HTTP and memory caches, routes, init scripts, bindings, downloads and clock, then re-applies `storageState`. A renderer left hung or busy by the previous test is detected and the context is replaced. See `tests/page/recycle-isolation.spec.ts`.
- **Retries react to changes instead of sleeping.** Auto-waiting assertions and actions re-check as soon as the page mutates or fires input/focus/scroll/animation/navigation events, rather than after Playwright's fixed 20–500 ms backoff.
- **One-frame stability check.** When no animation that can move elements is running, actionability's "stable" check compares the element's box now and on the next frame, instead of on two future frames.
- **Workers and browsers start before they are needed.** Worker processes, each launching the default browser, start while the CLI is still loading the config and test files; their number is remembered per project. Once a run has failing tests, a spare worker is kept ready so replacing a failed worker does not wait for a cold start.
- **Faster startup.** Node's compile cache is enabled for every process, and Playwright's own bundles additionally use a V8 code cache written after their code has run, so later runs skip compiling the functions they use. The CLI, MCP server, trace tools, vendored packages and the library half of `@playwright/test` load only when used, and test files are imported without an extra event-loop turn each.
- **Less work per call.** Call-site stacks captured for every step are source-mapped only for test files; error objects kept for rare failure paths format their stacks lazily; the script injected into every new document is minified and kept byte-identical across documents so the browser reuses its compiled code.
- **Faster screenshots and visual comparisons.** `page.screenshot()` asks Chromium for speed-optimized PNG encoding (same pixels, about half the capture time). `toHaveScreenshot()` compares a fast first capture against the baseline by decoded pixels, returns immediately for identical files, and decodes browser-made PNGs with a native-inflate decoder; every capture that can be written as a baseline keeps Chromium's default encoding, byte-identical to Playwright's.

## Differences from Playwright

- Contexts are recycled by default (Chromium). Tests see a fresh context and reports keep the usual "Create context"/"Close context" steps; a test that leaves a request in flight at its end gets up to 50 ms for it to settle. Set `FLASHWRIGHT_ISOLATION=strict` to create a new context for every test, exactly like Playwright.
- Chromium is launched with `--renderer-process-limit=1`, so a context's pages share one renderer process (cross-site frames still get their own).
- PNGs from `page.screenshot()` and `locator.screenshot()` have identical pixels but are larger files (typically 1.6–1.9×). `toHaveScreenshot()` baselines are unchanged.
- The CLI may start worker processes and a headless browser before it has read the config; unused ones are closed. Flashwright keeps two things in the system temp directory: `flashwright-worker-hints.json` (worker counts per project) and `flashwright-code-cache/` (a few MB per Node version). Set `PW_DISABLE_WORKER_STANDBY=1` or `FLASHWRIGHT_DISABLE_CODE_CACHE=1` to turn either off.
- Firefox and WebKit keep Playwright's behavior.

## Status

Flashwright is not published to npm yet. Today it builds from this repository:

```bash
npm ci
npm run build
npx playwright install chromium
```

`bench/consumer-test.mjs` packs the packages and runs an unmodified upstream example suite against them in a fresh project, as a drop-in replacement for `@playwright/test`.

The upstream suites are the compatibility bar. On Chromium, `tests/page` passes 2610/2610 (including the recycling isolation tests), matching pristine Playwright v1.64.1 on the same machine, and `tests/playwright-test` fails exactly the tests that pristine Playwright fails in this environment (branded Chrome and WebKit dependencies are missing here), apart from one timing-sensitive test that assumes two workers start at the same instant.

## Repository layout

- `packages/`, `tests/`, `utils/`, `docs/`: Playwright v1.64.1 with Flashwright's patches. Pristine upstream snapshots live on the `upstream/playwright` branch; merge new releases from there.
- `bench/`: the complete-suite benchmark (`run.mjs`, `matrix.mjs`) and the app corpora it uses.
- `README.playwright.md`: the upstream README.
- The previous experimental Rust engine is preserved at the `archive/swarm-rust-engine` tag.

## License

Apache-2.0, like Playwright. Flashwright is an independent fork and is not affiliated with Microsoft.
