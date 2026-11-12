# Configuration

[Back to the README](../README.md)

## Speed options

The table lists each option's default and tradeoffs. Test-scoped `use` options can be changed per project, file or `describe` block; runner settings such as `testOrder` belong in the config. For the overview and implementation details, see [Performance](performance.md).

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

## Web security

For a test front end whose API sends no CORS headers, `webSecurity: false` launches Chromium without same-origin enforcement and mixed-content blocking. It defaults to `true`.

```ts
export default defineConfig({
  use: { webSecurity: false },
});
```

## Additions

### A web server per project

Each project can declare its own `webServer`, with the same options as the top-level setting:

```ts
export default defineConfig({
  projects: [{
    name: 'admin',
    webServer: {
      command: 'npm run start:admin',
      url: 'http://localhost:3001',
    },
    use: { baseURL: 'http://localhost:3001' },
  }],
});
```

The servers start before the project's first test and stop at the end of the run. They only start when the run includes that project's tests, so selecting another project does not start the admin server.

### Options for one test

Put `use` alongside `tag` and `annotation` in a test's options instead of creating a `describe` group just for that test:

```ts
test('fits a phone', {
  use: { viewport: { width: 390, height: 844 } },
}, async ({ page }) => {
  await page.goto('/');
});
```

`test.describe()` accepts `use` too. Like `test.use()` in a group, these options cannot configure worker fixtures such as `browserName`.

### Prune stale snapshots

```bash
npx playwright test --prune-snapshots
```

After a complete passing run, this deletes and lists snapshot files that no test used, including renamed or removed screenshots and snapshot folders for deleted test files.

It does not prune filtered or sharded runs, or runs with `.only`. It keeps all snapshots belonging to a test file with a skipped test. Only files matching a project's snapshot path template for the current platform are eligible, so other platforms' baselines stay.

### Accept snapshots without a rerun

```bash
npx playwright accept-snapshots
```

This copies the actual snapshots from the previous run over the expected files, without re-running the tests with `--update-snapshots`. It uses each test's last attempt, so a retry that matched leaves nothing to accept. It also works with a `test-results` folder copied from CI.

## How the optimizations work

The implementation explanations have moved to [Performance](performance.md#implementation-details). That page also lists which optimisations are enabled by default, apply to local workflows, or need an explicit option.
