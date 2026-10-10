# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workloads.spec.mjs >> failure/sample/6
- Location: /retained/runner-matrix/pair-00-flashwright/project/workloads.spec.mjs:48:4

# Error details

```
Error: expect(locator("#missing")).toBeVisible(expected)
Timed out after 250ms
Locator: locator("#missing")
Expected: "visible"
Received: no matching element
```

```yaml
- text: Name
- textbox "Name"
- button "Increment"
- button "Save"
- status: Ready
- text: "0"
```

# Test source

```ts
  1  | import assert from 'node:assert/strict';
  2  | import { readFileSync } from 'node:fs';
  3  | import { test, expect, nativeBackendGuardActive } from './adapter.mjs';
  4  | 
  5  | const { configuration, launchIndex } = JSON.parse(readFileSync(new URL('./suite-configuration.json', import.meta.url), 'utf8'));
  6  | const contexts = new WeakSet();
  7  | let isolation;
  8  | let contextReused;
  9  | let operationStarted;
  10 | 
  11 | test.beforeEach(async ({ page }) => {
  12 |   operationStarted = undefined;
  13 |   contextReused = contexts.has(page.context());
  14 |   contexts.add(page.context());
  15 |   assert.equal(contextReused, false);
  16 |   await page.goto('/fixture');
  17 |   isolation = await page.evaluate(() => {
  18 |     const previous = { localStorage: localStorage.getItem('runner-suite'), sessionStorage: sessionStorage.getItem('runner-suite'), cookies: document.cookie };
  19 |     localStorage.setItem('runner-suite', 'previous-test');
  20 |     sessionStorage.setItem('runner-suite', 'previous-test');
  21 |     document.cookie = 'runner-suite=previous-test';
  22 |     return previous;
  23 |   });
  24 |   assert.deepEqual(isolation, { localStorage: null, sessionStorage: null, cookies: '' });
  25 | });
  26 | 
  27 | test.afterEach(async ({ page, browser }, testInfo) => {
  28 |   const milliseconds = operationStarted === undefined ? null : performance.now() - operationStarted;
  29 |   const observations = await page.evaluate(() => ({
  30 |     trustedClicks: window.observations.clicks.filter(Boolean).length,
  31 |     untrustedClicks: window.observations.clicks.filter(trusted => !trusted).length,
  32 |     trustedChanges: window.observations.changes.filter(Boolean).length,
  33 |     untrustedChanges: window.observations.changes.filter(trusted => !trusted).length,
  34 |     applicationCount: window.observations.count,
  35 |     viewport: { width: innerWidth, height: innerHeight }, focused: document.hasFocus(), visibilityState: document.visibilityState,
  36 |   }));
  37 |   testInfo.annotations.push({ type: 'runner-suite-observation', description: JSON.stringify({
  38 |     title: testInfo.title, milliseconds, isolation, contextReused, ...observations,
  39 |     browserVersion: browser.version(), nativeBackendGuardActive, workerProcess: process.pid,
  40 |     runtime: { name: process.versions.bun ? 'bun' : 'node', version: process.versions.bun ?? process.versions.node },
  41 |   }) });
  42 | });
  43 | 
  44 | const offset = launchIndex % configuration.workloads.length;
  45 | const workloads = configuration.workloads.slice(offset).concat(configuration.workloads.slice(0, offset));
  46 | for (const workload of workloads) for (const [phase, count] of [['warmup', configuration.warmupIterations], ['sample', configuration.measuredIterations]]) {
  47 |   for (let iteration = 0; iteration < count; iteration++) {
  48 |     test(`${workload}/${phase}/${iteration}`, async ({ page }) => {
  49 |       operationStarted = performance.now();
  50 |       if (workload === 'noop') assert.equal(await page.evaluate(() => 42), 42);
  51 |       else if (workload === 'interaction') {
  52 |         await page.getByRole('button', { name: 'Increment' }).click();
  53 |         await expect(page.locator('#count')).toHaveText('1');
  54 |       } else if (workload === 'assertion') {
  55 |         await page.evaluate(delay => window.delayStatus(delay), configuration.delayedAssertionMilliseconds);
  56 |         await expect(page.getByRole('status')).toHaveText('Ready');
  57 |       } else if (workload === 'navigation') {
  58 |         const response = await page.goto(`/fixture?navigation=${phase}-${iteration}`);
  59 |         assert.equal(response.status(), 200);
  60 |         await expect(page).toHaveTitle('Flashwright baseline');
  61 |         await expect(page.getByRole('status')).toHaveText('Ready');
  62 |       } else if (workload === 'setup') await expect(page.getByRole('status')).toHaveText('Ready');
  63 |       else if (workload === 'backend') {
  64 |         const name = `person-${iteration + (phase === 'sample' ? configuration.warmupIterations : 0) + 1}`;
  65 |         await page.getByLabel('Name').fill(name);
  66 |         const [response] = await Promise.all([
  67 |           page.waitForResponse(response => response.url().endsWith('/api/profile')),
  68 |           page.getByRole('button', { name: 'Save' }).click(),
  69 |         ]);
  70 |         assert.equal(response.status(), 200);
  71 |         await expect(page.getByRole('status')).toHaveText(`Saved ${name}`);
  72 |       } else if (workload === 'failure') {
  73 |         // Keep these as actual runner failures, including its ordinary worker restart policy.
> 74 |         await expect(page.locator('#missing')).toBeVisible({ timeout: configuration.expectedFailureTimeoutMilliseconds });
     |                                               ^ Error: expect(locator("#missing")).toBeVisible(expected)
  75 |       } else throw new Error(`Unknown workload: ${workload}`);
  76 |     });
  77 |   }
  78 | }
  79 | 
```