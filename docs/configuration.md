# Configuration

[Back to the README](../README.md)

## Speed options

Several speed options are on by default. You can change them per project, file or `describe` block, including restoring Playwright's waits and test order:

```ts
// playwright.config.ts: Playwright's behavior, for a suite that relies on it
export default defineConfig({
  testOrder: 'file',          // run tests in Playwright's order
  use: {
    waitForAnimations: true,  // wait for elements to stop moving before input
    failFastWhenIdle: false,  // let failing assertions wait out their timeout
  },
});

// a file or describe block that needs less
test.use({
  instantAnimations: true,                     // CSS and Web Animations end within a frame
  blockResources: ['image', 'font', 'media'],  // never load these
});
```

| Option | Default | What it does |
| --- | --- | --- |
| `waitForAnimations` | `false` | `true` makes pointer actions wait for CSS and Web Animations that move the element, like Playwright, for apps that ignore input while they animate. Electron windows keep Playwright's wait. |
| `failFastWhenIdle` | `true` | An assertion that hasn't passed fails once nothing can change the page before its timeout: no timer due, no request, socket, navigation, animation or worker, and no other call on the page. A test that changes the page from a timer in its own code while an assertion waits sets `false` (8 of Playwright's 2610 page tests do). |
| `isolation` | `'recycled'` | Each worker keeps one browser context and gives every test a new tab in it, reset between tests (on Firefox and WebKit, the same tab). `'strict'` gives every test a new context, like Playwright: slower, but nothing a reset could miss carries over. |
| `testOrder` | `'longest-first'` | With several workers, the tests that took longest last time start first. `'file'` keeps Playwright's order. |
| `workersPerProcess` | `1` | Workers that share one worker process (`--workers-per-process`). Each worker runs one test at a time; the workers of a process share Node.js, the code it loaded and the browser, where each worker's tests get contexts of their own. With 4 workers on TodoMVC, `2` takes a run from 795 to 590 MB and `4` to 493 MB, and makes it 1.08× and 1.12× faster. Each worker keeps its own `process.env`; tests that run at the same time in one process share global variables, the process and the browser: a crash, `process.exit()` or `browser.close()` ends them all. |
| `instantAnimations` | `false` | The page's CSS transitions, CSS animations and Web Animations run 1000× faster, so fades and slides end at once (Chromium). On a page with a fading dialog: 2.3× faster than without. |
| `blockResources` | none | Requests for these types (`image`, `media`, `font`, `stylesheet`, `script`) fail before any route sees them. On a 24-image product page: 1.4× faster, 6.8× with `instantAnimations`. |
| `locatorPolicy` | `'any'` | `'test-id'` lets only `getByTestId()` locators, and the methods that combine them, select elements; any other locator or selector fails right away. A test id is one attribute lookup, while role, label and text locators work out the role and text of the page's elements: on the 8,500 elements of the `inventory` benchmark, a named `getByRole()` takes 14 ms and a test id lookup 0.7 ms. |
| `webSecurity` | `true` | `false` launches Chromium without the same-origin policy and mixed-content blocking, for a front end whose API sends no CORS headers in tests. |
| `preloadPages` | `false` | While a test runs, the next test's page loads in a second context, and that test's first `goto` returns at once. Until then the test sees a blank tab; any other call first, or another URL, gets a reset tab as without the option. Takes effect with one worker, or workers fewer than half the CPU cores. With one worker: TodoMVC 1.26×, a suite waiting on its API 1.40× faster. Not for tests that change the server from Node before their `goto` (the page loaded before that change) or watch the requests it receives (the next test's page loads meanwhile). |

Playwright's own options combine with these: `javaScriptEnabled: false`, `serviceWorkers: 'block'`, `bypassCSP`.

## Additions

These additions cover things Playwright users have asked for. Existing Playwright configs and tests don't need to use them.

- **A web server per project**: `projects: [{ name: 'admin', webServer: { command: 'npm run start:admin', url: 'http://localhost:3001' }, use: { baseURL: 'http://localhost:3001' } }]`, with the options of the top-level `webServer`. A project's servers start before the first of its tests runs, only when the run has tests of the project (`--project shop` does not start the admin server), and stop at the end of the run.
- **Options for one test**: `test('fits a phone', { use: { viewport: { width: 390, height: 844 } } }, async ({ page }) => {})`, next to `tag` and `annotation`, instead of a `describe` group around the test. `test.describe()` takes `use` too. Like `test.use()` in a group, it cannot set the options of worker fixtures, such as `browserName`.
- **Stale snapshots**: `npx playwright test --prune-snapshots` deletes the snapshot files that no test used, and lists them: renamed or removed screenshots, and the folders of deleted test files. It only prunes after a complete run that passes, with no filter, shard or `.only`, and keeps all the snapshots of a test file with a skipped test. Only files that match a project's snapshot path template with this machine's platform count, so other platforms' screenshots stay.
- **Accept changed screenshots without a rerun**: when screenshots or snapshots no longer match, the run says so, and `npx playwright accept-snapshots` copies what the run produced over the expected files, instead of running everything again with `--update-snapshots`. It takes each test's last attempt, so a retry that matched leaves nothing to accept, and it works on a `test-results` folder copied from CI.

## How the optimizations work

The changes focus on browser reuse, waiting, startup and work repeated on every call. Some change what a test can observe, so read [Differences from Playwright](migration.md#differences-from-playwright) if your suite depends on those details.

- **Warm browsers, fresh contexts.** Compiling the application's JavaScript in a new renderer dominates many suites. Flashwright keeps one browser context per worker and gives each test a brand-new tab in it, then resets everything a test can change: options, permissions, cookies, every visited origin's storage (local, session, IndexedDB, Cache Storage, service workers), caches, routes, init scripts, bindings, downloads and clock, and re-applies `storageState`. The previous test's pages are stopped before anything is cleared, so a late script cannot leak state into the next test. See `tests/page/recycle-isolation.spec.ts`.
- **Waits that react to the page.** Auto-waiting actions and assertions re-check as soon as the page changes instead of after a 20–500 ms backoff. An assertion that cannot pass any more, because nothing can change the page before its timeout, fails right away.
- **No frame waits before input.** Clicks, hovers, taps and drags don't wait for animation frames or for moving elements to stop. Playwright's hit-target check still makes sure the element receives the input.
- **Workers and browsers ready before they're needed.** Worker processes and their browsers start while the CLI is still reading the config (the browser that all of the config's tests launched last time, with its launch options; it is used only if the config leaves the environment unchanged), a spare stands by once tests fail, and an idle spare already holds the context its first test will ask for. A worker whose tests use no browser closes the one it started: with 4 workers of API tests, the run peaks at 330 MB instead of 550. The longest tests start first.
- **A faster start.** A V8 code cache for Playwright's own bundles, lazy loading of everything a run doesn't use, and less work per call: lazy stack formatting, fewer browser round trips per action, minified page scripts the browser compiles once, and Chromium's DevTools protocol in the browser's own binary encoding (CBOR), so that it no longer converts every message to JSON and back: up to 9% faster on short tests, 4% on the TodoMVC suite with 4 workers (`FLASHWRIGHT_CDP_JSON=1` goes back to JSON).
- **Locators on large pages.** A named `getByRole()` first rules out, from their content, the elements whose accessible name cannot contain the one asked for, and computes only the others' names; role, label and text locators read each element's styles, role and labels once per query. On the admin app's 8,500 elements: a named `getByRole()` takes 14 ms instead of 41, `getByRole('row')` 2.3 ms instead of 7.8, `getByLabel()` 2.0 ms instead of 3.3.
- **Faster screenshots.** Speed-optimized PNG encoding for `page.screenshot()` (same pixels), and pixel comparison with fast paths for `toHaveScreenshot()`, whose baselines stay byte-identical to Playwright's. With `screenshot: 'only-on-failure'`, a recycled context's pages stand still when the test's context closes and are captured only if the test then fails, instead of every test taking a screenshot in case it does (TodoMVC: 1484 -> 1055 ms, screenshots off: 1051). A page waits at most 20 ms (the outcome normally comes within a millisecond), so what moves by itself, like a blinking caret or an animated image, moves no further than in the frame a screenshot waits for. A page that could still change otherwise (a call or request in flight, a WebSocket, a worker, a dialog, a loading image or font, playing media, styles for the `scripting` media feature) is captured right away, as before.
