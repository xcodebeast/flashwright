# Moving from Playwright

[Back to the README](../README.md)

## Differences from Playwright

- **Recycled contexts.** Tests get a fresh context, in a browser context the worker keeps between tests (Chromium launched by the test runner). Tests that record video get a recycled context too, whose tab starts recording when the test gets it (TodoMVC with `video: 'retain-on-failure'`: 2850 -> 1312 ms); with video on some attempts only, such as `on-first-retry`, those attempts get a new context, as they always do on Firefox and WebKit. Contexts that were paused or debugged, or visited a non-http origin are closed instead. `isolation: 'strict'` (or `FLASHWRIGHT_ISOLATION=strict`) creates a new context for every test, like Playwright. The browser behind recycled contexts runs a context's pages in one renderer process, so a crash or a busy script affects all of them. Firefox and WebKit cannot clear an origin's storage without navigating, and opening a page there costs most of a short test (about 90 ms on Firefox): their tests reuse one context and its tab, which goes back to a blank page between tests with the same things reset, apart from the tab's history, which keeps the earlier tests' pages (`page.goBack()` at the start of a test can go to one of them). TodoMVC on Firefox: 6520 -> 3868 ms (1.69×). `isolation: 'strict'` gives them a new context per test.
- **Pointer actions on moving elements** are dispatched without waiting for the element to stop, unless `waitForAnimations` is set; the hit-target check still verifies them.
- **Assertions on an idle page** fail before their timeout unless `failFastWhenIdle: false`; the call log says so. The test runner adds a small script to its pages for this, which wraps the timer, animation frame and message functions. `browser.newContext()` outside the test runner is unaffected.
- **Test order**: with several workers, the longest tests start first unless `testOrder: 'file'`.
- **Process lifecycle**: worker processes and a headless browser may start before the config is read (unused ones close), and a finished worker's browser is killed rather than closed gracefully once no context is left open.
- **Warm session** (outside CI; `FLASHWRIGHT_SESSION=0` turns it off): after `playwright test` exits, a session process, the next run's runner and workers, and the run's browsers keep running, for up to 5 minutes after the last run. A test can see a browser process that an earlier run used, with its context reset as between two tests of one run.
- **Agent mode**: under a coding agent, the default terminal reporter is the `agent` one (see [agent mode](agents.md#agent-mode)); `agentMode: false` gives Playwright's.
- **Call logs** of an action or assertion whose element never appeared end with what the page has instead; finding it takes at most 500 ms, after the call has failed.
- **File watching** (`--watch` and UI mode) reacts 100 ms after the last change to a file instead of 250 ms.
- **Actions** wait for the browser's next frame, up to 140 ms, only in a run with `--video` or `--demo`.
- **Types**: the methods the documentation discourages are marked `@deprecated`, so editors strike them through; they work as before.
- **Screenshot files** have identical pixels but are 1.6–1.9× larger PNGs. `toHaveScreenshot()` baselines are unchanged.
- **Temporary files**: worker counts, per-test durations, the context options and the headless browser launch options each config used last (never storage state, credentials, headers, a proxy, certificates, environment variables, browser preferences or arguments with values other than a few harmless ones; readable only by you) and a V8 code cache live in the system temp directory. `PW_DISABLE_WORKER_STANDBY=1` and `FLASHWRIGHT_DISABLE_CODE_CACHE=1` turn off the first and the last.
- **Firefox and WebKit** keep Playwright's behavior, apart from reusing one tab per worker (see recycled contexts above) and the options above that apply to them, and **Electron** windows keep Playwright's waits for animations and assertion timeouts.

Flashwright runs Playwright's own browser builds. Playwright already launches them without what tests never see (sandbox, Safe Browsing, background networking, updates, extensions, sync, crash reporting); further switches such as `--disable-gpu` measured no faster, so there is no custom browser to install or trust.

## Deprecated APIs

Playwright still ships about 95 methods its documentation discourages: the selector-based ones such as `page.click(selector)` and `page.fill(selector, value)`, element handles, `waitForNavigation`, `waitForTimeout`. Flashwright keeps them working and marks them `@deprecated` in its types, so that editors strike them through.

## Migrate selector-based calls

`npx playwright codemod` shows, as a diff, how it rewrites the selector-based calls to locators (`page.click('#go')` becomes `page.locator('#go').click()`), `--write` applies it, and it lists with their location the calls to change by hand: element handles, `$eval`, `waitForNavigation`, `waitForTimeout`, `networkidle`. Locators are strict: where a selector matched several elements, the old call used the first one and the rewritten call fails; `--keep-first` adds `.first()` to keep the old behavior.

## Run on Bun

```bash
bunx --bun playwright test
```

Flashwright handles TypeScript configs and tests on Bun. Stock Playwright 1.64.1 parses TypeScript as JavaScript there and fails at the first type annotation. For the Node.js requirement and installation commands, see [Install](../README.md#install).
