# Performance

[Back to the README](../README.md) · [Configuration](configuration.md#speed-options) · [Benchmark methodology and results](benchmarks.md#how-many-runs)

This is the overview of Flashwright's optimisations. The benchmark matrix measures complete commands, including startup and shutdown. Gains depend on where a suite spends its time: application delays and backend response times still have to finish.

## Enabled by default

These apply where the browser and execution mode support them. Browser exceptions, observable differences and opt-outs are documented in [Migration](migration.md#differences-from-playwright).

- **[Reuse browser contexts](#warm-browsers-fresh-contexts).** Reset a worker's context between tests instead of creating one each time. Firefox and WebKit also reuse the tab. Use `isolation: 'strict'` for a new context per test.
- **[React when the page changes](#waits-that-react-to-the-page).** Actions and assertions re-check on page changes instead of waiting through a 20–500 ms backoff.
- **[Fail early on an idle page](#waits-that-react-to-the-page).** Assertions stop waiting when nothing can change the page before their timeout. Set `failFastWhenIdle: false` to wait out the timeout.
- **[Skip animation-frame waits before input](#no-frame-waits-before-input).** Pointer actions skip waits for elements to stop moving, while retaining the hit-target check. Set `waitForAnimations: true` to restore the wait. Electron keeps Playwright's waits.
- **[Start workers and browsers early](#workers-and-browsers-ready-before-theyre-needed).** Start them while the CLI reads the config, prepare spares for failures, and close browsers that a worker does not need.
- **[Run the longest tests first](#workers-and-browsers-ready-before-theyre-needed).** Use previous durations to schedule tests across workers. Set `testOrder: 'file'` to restore Playwright's order.
- **[Cache compiled code and load less](#a-faster-start).** Use a V8 code cache, load unused modules lazily, and let the browser compile minified page scripts once.
- **[Do less work per call](#a-faster-start).** Format stacks lazily and reduce browser round trips.
- **[Use binary browser messages](#a-faster-start).** Chromium's DevTools connection uses CBOR instead of converting messages to JSON and back. `FLASHWRIGHT_CDP_JSON=1` restores JSON.
- **[Make locators cheaper](#locators-on-large-pages).** Avoid repeated style, role and label calculations, and rule out irrelevant candidates before computing accessible names.
- **[Encode and compare screenshots faster](#faster-screenshots).** Preserve pixels while using faster PNG encoding and pixel-comparison fast paths. PNG files are larger; visual baselines stay unchanged.
- **[Avoid unnecessary failure screenshots](#faster-screenshots).** With `screenshot: 'only-on-failure'`, briefly hold eligible pages while the outcome is determined, so passing tests do not need a screenshot.

## Local workflows

- **[Warm sessions](agents.md#warm-session).** Keep browsers and warmed renderers between commands, with fresh runner and worker processes for each run. Enabled by default outside CI, Windows and debugging modes; set `FLASHWRIGHT_SESSION=0` to disable it. The session uses memory while waiting and expires after five minutes by default.
- **[Watch mode](agents.md#watch-mode).** Opt in with `--watch`. Run affected tests without first listing the whole suite, react sooner to file changes, and prepare the next run's processes in advance.
- **[Adaptive MCP settling](agents.md#adaptive-mcp-settling).** Opt in with `playwright mcp --adaptive-settle` to return when the page settles instead of waiting a fixed 500 ms.

## Optional settings

These need an explicit setting. The [configuration table](configuration.md#speed-options) contains the defaults, measurements and limitations.

| Setting | What it changes | Main tradeoff or restriction |
| --- | --- | --- |
| `workersPerProcess` | Share Node.js, loaded code and a browser between workers, with separate contexts | Workers share process globals and the impact of a crash or browser shutdown |
| `preloadPages` | Load the next test's page while the current test runs | Limited to low worker counts; the page can load before the next test changes server state |
| `instantAnimations` | Run CSS transitions, CSS animations and Web Animations 1000× faster | Chromium only; changes the timing of the app's animations |
| `blockResources` | Skip selected resource types, such as images, fonts and media | Tests no longer exercise those resources |
| `locatorPolicy: 'test-id'` | Require test-ID locators and their combinations | Existing role, label, text and selector-based locators fail |

## Implementation details

The changes focus on browser reuse, waiting, startup and work repeated on every call. Some change what a test can observe, so read [Differences from Playwright](migration.md#differences-from-playwright) if your suite depends on those details.

### Warm browsers, fresh contexts

Compiling the application's JavaScript in a new renderer dominates many suites. Flashwright keeps one browser context per worker and gives each test a brand-new tab in it, then resets everything a test can change: options, permissions, cookies, every visited origin's storage (local, session, IndexedDB, Cache Storage, service workers), caches, routes, init scripts, bindings, downloads and clock, and re-applies `storageState`. The previous test's pages are stopped before anything is cleared, so a late script cannot leak state into the next test. See `tests/page/recycle-isolation.spec.ts`.

### Waits that react to the page

Auto-waiting actions and assertions re-check as soon as the page changes instead of after a 20–500 ms backoff. An assertion that cannot pass any more, because nothing can change the page before its timeout, fails right away.

### No frame waits before input

Clicks, hovers, taps and drags don't wait for animation frames or for moving elements to stop. Playwright's hit-target check still makes sure the element receives the input.

### Workers and browsers ready before they're needed

Worker processes and their browsers start while the CLI is still reading the config (the browser that all of the config's tests launched last time, with its launch options; it is used only if the config leaves the environment unchanged), a spare stands by once tests fail, and an idle spare already holds the context its first test will ask for. A worker whose tests use no browser closes the one it started: with 4 workers of API tests, the run peaks at 330 MB instead of 550. The longest tests start first.

### A faster start

A V8 code cache for Playwright's own bundles, lazy loading of everything a run doesn't use, and less work per call: lazy stack formatting, fewer browser round trips per action, minified page scripts the browser compiles once, and Chromium's DevTools protocol in the browser's own binary encoding (CBOR), so that it no longer converts every message to JSON and back: up to 9% faster on short tests, 4% on the TodoMVC suite with 4 workers (`FLASHWRIGHT_CDP_JSON=1` goes back to JSON).

`playwright cli` commands start in about 45 ms instead of 260 ms in the reported measurement.

### Locators on large pages

A named `getByRole()` first rules out, from their content, the elements whose accessible name cannot contain the one asked for, and computes only the others' names; role, label and text locators read each element's styles, role and labels once per query. On the admin app's 8,500 elements: a named `getByRole()` takes 14 ms instead of 41, `getByRole('row')` 2.3 ms instead of 7.8, `getByLabel()` 2.0 ms instead of 3.3.

### Faster screenshots

Speed-optimized PNG encoding for `page.screenshot()` (same pixels), and pixel comparison with fast paths for `toHaveScreenshot()`, whose baselines stay byte-identical to Playwright's. With `screenshot: 'only-on-failure'`, a recycled context's pages stand still when the test's context closes and are captured only if the test then fails, instead of every test taking a screenshot in case it does (TodoMVC: 1484 -> 1055 ms, screenshots off: 1051). A page waits at most 20 ms (the outcome normally comes within a millisecond), so what moves by itself, like a blinking caret or an animated image, moves no further than in the frame a screenshot waits for. A page that could still change otherwise (a call or request in flight, a WebSocket, a worker, a dialog, a loading image or font, playing media, styles for the `scripting` media feature) is captured right away, as before.
