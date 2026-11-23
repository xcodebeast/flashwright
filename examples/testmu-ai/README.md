# Flashwright on the TestMu AI cloud grid

Three TodoMVC tests that run on a local Chromium or on the [TestMu AI](https://www.testmuai.com/playwright-testing/) (formerly LambdaTest) browser cloud, without changing the tests. The grid project uses Playwright's `connectOptions`, so the browser runs on the grid and Flashwright runs on your machine or CI.

## Run locally

```bash
npm install
npx playwright install chromium
npm test
```

## Run on the grid

Set your TestMu AI username and access key, from the account's profile page:

```bash
export LT_USERNAME=<username>
export LT_ACCESS_KEY=<access key>
npm run test:testmu
```

The run shows up as a build named `Flashwright example` in the automation dashboard, with video, network and console logs. Set `LT_BUILD_NAME` to rename it.

## How it works

- `playwright.config.ts` has two projects. `chromium` launches a local browser. `testmu-chrome` builds a capabilities object (browser, version, platform, credentials) and passes it to the grid in the `wsEndpoint` of `connectOptions`.
- Each worker connects once and runs its tests in that grid session. Use `--workers` to set how many sessions run in parallel.
- `tests/fixtures.ts` tells the grid whether the session passed. A worker's tests share a session, so one failed test marks it failed.

## What changes on a grid

The grid runs stock Playwright's server and chooses it by the `playwrightClientVersion` capability. The config sends Flashwright's upstream version (`1.64.1`, without the `-flashwright.N` suffix). Without that capability the grid cannot match the fork's version string and refuses the connection with a 500.

Flashwright does not recycle browser contexts in a browser it connects to, because that needs its own server. Every test gets a new context, as with `isolation: 'strict'`. The rest of what Flashwright changes in the test runner and the client still applies.
