# Flashwright

Flashwright is a faster [Playwright](https://playwright.dev). It is a fork of Playwright v1.64.1 with the same API, test runner, reporters, trace viewer and browsers, changed only where time is spent. Existing Playwright suites run unmodified and finish in about half the time.

The fork follows upstream closely: Playwright's own test suites are the regression bar, and every Flashwright change is a small, documented patch that can be carried to new Playwright releases.

## How much faster

Complete `test` command wall-clock, Flashwright vs stock `@playwright/test` 1.64.1, same machine, same Chromium (headless shell 156), median of 3 alternating runs. Reproduce with `node bench/matrix.mjs`.

| Scenario | Tests | Workers | Playwright | Flashwright | Speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| TodoMVC (upstream example suite) | 24 | 1 | 3742 ms | 1841 ms | 2.03× |
| TodoMVC | 24 | 4 | 1780 ms | 1109 ms | 1.61× |
| SVGOMG (upstream example suite) | 6 | 1 | 1707 ms | 1093 ms | 1.56× |
| SVGOMG | 6 | 4 | 1282 ms | 1008 ms | 1.27× |
| Trivial test | 15 | 1 | 1049 ms | 440 ms | 2.38× |
| Click + assertion | 15 | 1 | 1630 ms | 768 ms | 2.12× |
| Assertion on a delayed update | 15 | 1 | 1220 ms | 568 ms | 2.15× |
| Navigation | 15 | 1 | 1295 ms | 585 ms | 2.21× |
| Fixture setup only | 15 | 1 | 1214 ms | 545 ms | 2.23× |
| Form submit to a backend (20 ms API) | 15 | 1 | 2015 ms | 1051 ms | 1.92× |
| Failing assertions (250 ms timeout each) | 15 | 1 | 4775 ms | 4208 ms | 1.13× |

The failure scenario is bounded by the timeouts the tests ask for: 15 × 250 ms of waiting cannot get faster without changing what the tests mean.

## What changed

Each item keeps Playwright's observable behavior; the differences that remain are listed below.

- **Warm renderers through context recycling.** Recompiling the application's JavaScript in a fresh renderer for every test dominates many suites (47 ms of a 60 ms TodoMVC setup). Flashwright keeps one browser context per worker and gives each test a brand-new tab in it, opened next to the old one so it lands in the already-warm renderer. Between tests it resets everything a test can change: context options, permissions, cookies, every visited origin's storage (local, session, IndexedDB, Cache Storage, service workers, ...), the HTTP and memory caches, routes, init scripts, bindings, downloads and clock. A renderer left hung or busy by the previous test is detected and the context is replaced. See `tests/page/recycle-isolation.spec.ts`.
- **Retries react to changes instead of sleeping.** Auto-waiting assertions and actions re-check as soon as the page mutates or fires input/focus/scroll/animation/navigation events, rather than after Playwright's fixed 20–500 ms backoff.
- **One-frame stability check.** When no CSS or Web Animations are running, actionability's "stable" check compares the element's box now and on the next frame, instead of on two future frames. Clicks drop from ~30 ms to ~13 ms.
- **Faster startup.** The first worker process and its browser start while the CLI is still loading config and tests; Node's compile cache is enabled for all processes; heavy modules (MCP, trace tools, vendored packages) load only when used.
- **Less work per API call.** Call-site stacks captured for every step are source-mapped only for test files, not for every frame.

## Differences from Playwright

- Contexts are recycled by default (Chromium). Tests see a fresh context, but internal "Create context"/"Close context" steps no longer appear in reports, and a test that leaves a request in flight at its end gets up to 50 ms for it to settle. Set `FLASHWRIGHT_ISOLATION=strict` to create a new context for every test, exactly like Playwright.
- Chromium is launched with `--renderer-process-limit=1`, so a context's pages share one renderer process (cross-site frames still get their own).
- Firefox and WebKit keep Playwright's behavior.

## Status

Flashwright is not published to npm yet. Today it builds from this repository:

```bash
npm ci
npm run build
npx playwright install chromium
```

The upstream suites are the compatibility bar: `tests/page` passes 2608/2608 on Chromium (including the recycling isolation tests), matching pristine Playwright v1.64.1 on the same machine.

## Repository layout

- `packages/`, `tests/`, `utils/`, `docs/`: Playwright v1.64.1 with Flashwright's patches. Pristine upstream snapshots live on the `upstream/playwright` branch; merge new releases from there.
- `bench/`: the complete-suite benchmark (`run.mjs`, `matrix.mjs`) and the app corpora it uses.
- `README.playwright.md`: the upstream README.
- The previous experimental Rust engine is preserved at the `archive/swarm-rust-engine` tag.

## License

Apache-2.0, like Playwright. Flashwright is an independent fork and is not affiliated with Microsoft.
