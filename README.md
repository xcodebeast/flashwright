# Flashwright

Flashwright is a faster [Playwright](https://playwright.dev). It is a fork of Playwright v1.64.1 with the same API, test runner, reporters, trace viewer and browsers, changed only where time is spent. Existing Playwright suites run unmodified and finish in about half the time.

The fork follows upstream closely: Playwright's own test suites are the regression bar, and every Flashwright change is a small, documented patch that can be carried to new Playwright releases.

## How much faster

Complete `test` command wall-clock, Flashwright vs stock `@playwright/test` 1.64.1, same machine (6 CPUs), same Chromium (headless shell 156), median of 5 alternating runs (15 for the two 4-worker rows marked *, whose runs vary more). Reproduce with `node bench/matrix.mjs 5 1,4`.

| Scenario | Tests | Workers | Playwright | Flashwright | Speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| TodoMVC (upstream example suite) | 24 | 1 | 3700 ms | 1165 ms | 3.18× |
| TodoMVC | 24 | 4 | 1793 ms | 786 ms | 2.28× |
| SVGOMG (upstream example suite) | 6 | 1 | 1721 ms | 563 ms | 3.06× |
| SVGOMG * | 6 | 4 | 1258 ms | 739 ms | 1.70× |
| Shop app (login setup project, 40 ms API latency) | 18 | 1 | 6364 ms | 3075 ms | 2.07× |
| Shop app * | 18 | 4 | 2597 ms | 1293 ms | 2.01× |
| A single test (an agent re-running one test; measured separately) | 1 | 1 | 613 ms | 197 ms | 3.11× |
| Trivial test | 15 | 1 | 1037 ms | 350 ms | 2.96× |
| Click + assertion | 15 | 1 | 1636 ms | 441 ms | 3.71× |
| Assertion on a delayed update | 15 | 1 | 1211 ms | 480 ms | 2.52× |
| Navigation | 15 | 1 | 1269 ms | 471 ms | 2.69× |
| Fixture setup only | 15 | 1 | 1189 ms | 402 ms | 2.96× |
| Form submit to a backend (20 ms API) | 15 | 1 | 2015 ms | 786 ms | 2.56× |
| `toHaveScreenshot()` against a baseline | 15 | 1 | 2397 ms | 1002 ms | 2.39× |
| `page.screenshot()` to a file | 15 | 1 | 1943 ms | 865 ms | 2.25× |
| Suite with real failures (every third test) | 15 | 1 | 4370 ms | 2162 ms | 2.02× |
| Expected failures (250 ms timeout each) | 15 | 1 | 4765 ms | 4108 ms | 1.16× |

The single-file workloads run in one worker regardless of the worker setting; their 4-worker numbers match the 1-worker ones.

Some scenarios mostly wait for things no framework can make faster: assertion timeouts that are meant to expire, and the application server's response time. There the wall-clock ratio is capped by the waiting, so the matrix also reports the time each framework adds on top of it (wall time minus the waits the tests ask for; for the shop, minus the time an API request was pending, measured in each framework's own runs):

| Scenario | Workers | Waits the tests ask for | Playwright adds | Flashwright adds | Speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| Expected failures | 1 | 15 × 250 ms | 1015 ms | 358 ms | 2.84× |
| Suite with real failures | 1 | 5 × 250 ms | 3120 ms | 912 ms | 3.42× |
| Form submit to a backend | 1 | 15 × 20 ms | 1715 ms | 486 ms | 3.53× |
| Assertion on a delayed update | 1 | 15 × 8 ms | 1091 ms | 360 ms | 3.03× |
| Shop app | 1 | ~2.1 s of API time | 4244 ms | 1023 ms | 4.15× |
| Shop app * | 4 | ~1.14 s (Playwright), ~0.87 s (Flashwright) of API time | 1455 ms | 427 ms | 3.41× |

SVGOMG with 4 workers is bound by the application itself. Once the demo loads, the app's settings panel waits 50 ms and then slides in for 300 ms (`transition: transform .3s ease-out .05s`), and one test clicks two controls inside it right after loading the demo. With four browsers rendering the app on 6 CPUs, the page's main thread is busy rendering the optimized SVG, so even input events take tens of milliseconds to be handled; the clicks miss that 50 ms window and every framework must wait for the slide to finish. Some single-worker runs hit the same wait. The shop with 4 workers is within noise of 2× (3.4× on the time the framework adds); the rest of its wall time is the app's API latency spread unevenly across workers. Both get faster with the speed options below, which are on by default.

### Speed options

Flashwright defaults to speed. These options trade some of Playwright's guarantees for it; set them per project, per file or per describe block, like any other option:

```ts
// playwright.config.ts
export default defineConfig({
  testOrder: 'file',        // keep Playwright's test order
  use: {
    waitForAnimations: true, // wait for elements to stop animating before input, like Playwright
  },
});

// a single file or describe block
test.use({ waitForAnimations: true });
```

| Option | Default | What it does | Effect here |
| --- | --- | --- | --- |
| `waitForAnimations` (`use`) | `false` | With `false`, clicks, hovers, taps and drags do not wait for CSS transitions, CSS animations or Web Animations that move the element to finish; Playwright's hit-target check still makes sure the element receives the input. Set `true` for an app that ignores input while it animates. | SVGOMG, 4 workers: 739 ms → 481 ms (2.62× vs Playwright) |
| `testOrder` (config, `--test-order`) | `'longest-first'` | With more than one worker, the test groups that took longest in the previous run of the config start first, as Jest does, so a long test does not start last and run alone at the end. `'file'` keeps Playwright's order, for suites whose tests depend on what ran before them in the same worker (Playwright's own library suite has such tests). | Shop, 4 workers: 1293 ms → 1234 ms (2.10× vs Playwright) |

## What changed

Each item keeps Playwright's observable behavior; the differences that remain are listed below.

- **Warm renderers through context recycling.** Recompiling the application's JavaScript in a fresh renderer for every test dominates many suites (47 ms of a 60 ms TodoMVC setup). Flashwright keeps one browser context per worker and gives each test a brand-new tab in it, opened next to the old one so it lands in the already-warm renderer. Between tests it resets everything a test can change: context options, permissions, cookies, every visited origin's storage (local, session, IndexedDB, Cache Storage, service workers, ...), the HTTP and memory caches, routes, init scripts, bindings, downloads and clock, then re-applies `storageState`. Before clearing anything it stops the previous test's pages (scripts disabled, documents replaced), so a script still writing storage when a test ends cannot leak into the next test. A renderer left hung or busy by the previous test is detected and the context is replaced. See `tests/page/recycle-isolation.spec.ts`.
- **Retries react to changes instead of sleeping.** Auto-waiting assertions and actions re-check as soon as the page mutates or fires input/focus/scroll/animation/navigation events, rather than after Playwright's fixed 20–500 ms backoff.
- **No frame wait before clicks.** Actionability's "stable" check keeps a click from landing on a moving element. Clicks, hovers, taps and drags no longer wait for animation frames: Playwright already checks, when the input events are dispatched, that they reach the element, and retries otherwise. With `waitForAnimations: true`, they wait while a CSS transition, CSS animation or Web Animation can move the element (ones that only change colors or opacity, transform some other element, or are still in their start delay do not count), comparing the element's box across frames. Right after an action that made the page navigate (a download link, for instance) the next one waits a frame, since the browser may still be handling that navigation. `waitForElementState('stable')` and element screenshots keep the frame-based check.
- **Longest tests first.** With more than one worker, test groups start longest first, by the previous run's durations (see `testOrder` above).
- **Workers and browsers start before they are needed.** Worker processes, each launching the default browser, start while the CLI is still loading the config and test files; their number is remembered per project, and on a first run (or in CI) the configured number starts as soon as the config is read. Once a run has failing tests, a spare worker is kept ready so replacing a failed worker does not wait for a cold start, and an exiting worker ends its browser right away instead of waiting for a graceful shutdown.
- **Faster startup.** Node's compile cache is enabled for every process, and Playwright's own bundles additionally use a V8 code cache written after their code has run, so later runs skip compiling the functions they use. The CLI, MCP server, trace tools, vendored packages and the library half of `@playwright/test` load only when used, the large bundles are kept ASCII-only so V8 holds them as compact one-byte strings, and test files are imported without an extra event-loop turn each.
- **Less work per call.** Call-site stacks captured for every step are source-mapped only for test files; error objects kept for rare failure paths format their stacks lazily; the script injected into every new document is minified and kept byte-identical across documents so the browser reuses its compiled code.
- **Faster screenshots and visual comparisons.** `page.screenshot()` asks Chromium for speed-optimized PNG encoding (same pixels, about half the capture time). `toHaveScreenshot()` compares a fast first capture against the baseline by decoded pixels, returns immediately for identical files, and decodes browser-made PNGs with a native-inflate decoder; every capture that can be written as a baseline keeps Chromium's default encoding, byte-identical to Playwright's.

## For agents

- `playwright cli <command>` (driving a browser session step by step) starts in ~50 ms instead of ~180 ms.
- Opt-in adaptive settling for the MCP server and `playwright cli`: after each action Playwright waits a fixed 500 ms (and again if the action made requests) so the next snapshot shows the result. With `playwright mcp --adaptive-settle`, `PLAYWRIGHT_MCP_ADAPTIVE_SETTLE=1` (which `playwright cli` sessions read too) or `timeouts.adaptiveSettle: true` in the MCP or CLI config file, the response comes once the page has had no DOM changes for 100 ms and the action's requests have finished, still never later than the settle timeout. On a click that saves through an API, 1014 ms becomes 234 ms. A page that changes after a timer (a debounced search, for example) can be captured before it does, which is why it is opt-in.

## Differences from Playwright

- Contexts are recycled by default (Chromium launched by the test runner; not for browsers reached through `connectOptions`). Tests see a fresh context and reports keep the usual "Create context"/"Close context" steps; a test that leaves a request in flight at its end gets up to 50 ms for it to settle. A context in which the test paused, used the debugger, the recorder or `page.pickLocator()`, or visited a non-http origin is closed instead of recycled. Tests that record video get a new context; with `video: 'on-first-retry'` or `'on-all-retries'` first attempts still recycle. Explicit context reuse (`reuseContext`, VS Code, UI mode) keeps Playwright's own behavior. Set `FLASHWRIGHT_ISOLATION=strict` to create a new context for every test, exactly like Playwright.
- The browser the test runner launches for recycled contexts runs with `--renderer-process-limit=1` and without script streaming, so a context's same-site pages share one renderer process (cross-site frames still get their own): a renderer crash or a busy script affects all of them. Browsers that tests or scripts launch themselves keep Playwright's defaults.
- A click, hover, tap or drag on a moving element is dispatched without waiting for the element to stop, unless `waitForAnimations` is set (and even then for animations only, not for elements that scripts move); the hit-target check still makes sure the element receives it. Three upstream page tests assert the wait and set `waitForAnimations: true`.
- With more than one worker, tests start longest first unless `testOrder: 'file'` is set.
- When a worker exits, the browser the test runner launched for it is killed rather than shut down gracefully, once no context is left open (contexts write their traces, videos and HARs when they close); its temporary profile is still removed. If tests left contexts open, it closes gracefully as before.
- PNGs from `page.screenshot()` and `locator.screenshot()` have identical pixels but are larger files (typically 1.6–1.9×). `toHaveScreenshot()` baselines are unchanged.
- The CLI may start worker processes and a headless browser before it has read the config; unused ones are closed. Flashwright keeps three things in the system temp directory: `flashwright-worker-hints.json` (worker counts per project), `flashwright-code-cache/` (a few MB per Node version) and `flashwright-test-durations/` (the last duration of each test, per config, unless `testOrder` is `'file'`). Set `PW_DISABLE_WORKER_STANDBY=1` or `FLASHWRIGHT_DISABLE_CODE_CACHE=1` to turn the first two off.
- Firefox and WebKit keep Playwright's behavior.

## Status

Flashwright is not published to npm yet. Today it builds from this repository:

```bash
npm ci
npm run build
npx playwright install chromium
```

It is packaged as `flashwright-test`, `flashwright` and `flashwright-core` (Playwright's `@playwright/test`, `playwright` and `playwright-core`), which depend on each other through npm aliases. Once published, a project switches by replacing one dependency, keeping its imports and `npx playwright` commands:

```bash
npm i -D @playwright/test@npm:flashwright-test@1.64.1-flashwright.1
```

`node utils/flashwright/pack.mjs` builds those packages from a clean build (`npm run clean && npm run build`) into `workbench/npm/` (`--dry-run-publish` checks them with `npm publish --dry-run`), and `bench/consumer-test.mjs --npm` installs them into a fresh project that way and runs an unmodified upstream example suite.

The upstream suites are the compatibility bar, compared against pristine Playwright v1.64.1 on the same machine (Chromium unless noted; WebKit cannot run on this machine):

| Suite | Result |
| --- | --- |
| `tests/page` | 2610/2610, including the recycling isolation tests |
| `tests/page` on Firefox | same as pristine (2578 passed); Flashwright does not recycle Firefox contexts, but its click changes apply there too |
| `tests/playwright-test` | same failures as pristine (branded Chrome and WebKit dependencies are missing here) |
| `tests/library` | same as pristine, except two checks that read Playwright's internal bookkeeping (the server-side context list and CDP session map, which include the recycled context between tests) |
| `tests/mcp` | same as pristine |
| `tests/electron` | same as pristine apart from screenshot tests that are flaky under Electron here in both |
| `tests/stress` | 1100/1100 (33 s vs 49 s) |
| `tests/extension` | 41/41 |

A few timing-sensitive tests can differ run to run in both.

## Repository layout

- `packages/`, `tests/`, `utils/`, `docs/`: Playwright v1.64.1 with Flashwright's patches. Pristine upstream snapshots live on the `upstream/playwright` branch; merge new releases from there.
- `bench/`: the complete-suite benchmark (`run.mjs`, `matrix.mjs`) and the app corpora it uses.
- `README.playwright.md`: the upstream README.
- The previous experimental Rust engine is preserved at the `archive/swarm-rust-engine` tag.

## License

Apache-2.0, like Playwright. Flashwright is an independent fork and is not affiliated with Microsoft.
