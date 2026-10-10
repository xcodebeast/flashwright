import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, expect, nativeBackendGuardActive } from './adapter.mjs';

const { configuration, launchIndex } = JSON.parse(readFileSync(new URL('./suite-configuration.json', import.meta.url), 'utf8'));
const contexts = new WeakSet();
let isolation;
let contextReused;
let operationStarted;

test.beforeEach(async ({ page }) => {
  operationStarted = undefined;
  contextReused = contexts.has(page.context());
  contexts.add(page.context());
  assert.equal(contextReused, false);
  await page.goto('/fixture');
  isolation = await page.evaluate(() => {
    const previous = { localStorage: localStorage.getItem('runner-suite'), sessionStorage: sessionStorage.getItem('runner-suite'), cookies: document.cookie };
    localStorage.setItem('runner-suite', 'previous-test');
    sessionStorage.setItem('runner-suite', 'previous-test');
    document.cookie = 'runner-suite=previous-test';
    return previous;
  });
  assert.deepEqual(isolation, { localStorage: null, sessionStorage: null, cookies: '' });
});

test.afterEach(async ({ page, browser }, testInfo) => {
  const milliseconds = operationStarted === undefined ? null : performance.now() - operationStarted;
  const observations = await page.evaluate(() => ({
    trustedClicks: window.observations.clicks.filter(Boolean).length,
    untrustedClicks: window.observations.clicks.filter(trusted => !trusted).length,
    trustedChanges: window.observations.changes.filter(Boolean).length,
    untrustedChanges: window.observations.changes.filter(trusted => !trusted).length,
    applicationCount: window.observations.count,
    viewport: { width: innerWidth, height: innerHeight }, focused: document.hasFocus(), visibilityState: document.visibilityState,
  }));
  testInfo.annotations.push({ type: 'runner-suite-observation', description: JSON.stringify({
    title: testInfo.title, milliseconds, isolation, contextReused, ...observations,
    browserVersion: browser.version(), nativeBackendGuardActive, workerProcess: process.pid,
    runtime: { name: process.versions.bun ? 'bun' : 'node', version: process.versions.bun ?? process.versions.node },
  }) });
});

const offset = launchIndex % configuration.workloads.length;
const workloads = configuration.workloads.slice(offset).concat(configuration.workloads.slice(0, offset));
for (const workload of workloads) for (const [phase, count] of [['warmup', configuration.warmupIterations], ['sample', configuration.measuredIterations]]) {
  for (let iteration = 0; iteration < count; iteration++) {
    test(`${workload}/${phase}/${iteration}`, async ({ page }) => {
      operationStarted = performance.now();
      if (workload === 'noop') assert.equal(await page.evaluate(() => 42), 42);
      else if (workload === 'interaction') {
        await page.getByRole('button', { name: 'Increment' }).click();
        await expect(page.locator('#count')).toHaveText('1');
      } else if (workload === 'assertion') {
        await page.evaluate(delay => window.delayStatus(delay), configuration.delayedAssertionMilliseconds);
        await expect(page.getByRole('status')).toHaveText('Ready');
      } else if (workload === 'navigation') {
        const response = await page.goto(`/fixture?navigation=${phase}-${iteration}`);
        assert.equal(response.status(), 200);
        await expect(page).toHaveTitle('Flashwright baseline');
        await expect(page.getByRole('status')).toHaveText('Ready');
      } else if (workload === 'setup') await expect(page.getByRole('status')).toHaveText('Ready');
      else if (workload === 'backend') {
        const name = `person-${iteration + (phase === 'sample' ? configuration.warmupIterations : 0) + 1}`;
        await page.getByLabel('Name').fill(name);
        const [response] = await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/api/profile')),
          page.getByRole('button', { name: 'Save' }).click(),
        ]);
        assert.equal(response.status(), 200);
        await expect(page.getByRole('status')).toHaveText(`Saved ${name}`);
      } else if (workload === 'failure') {
        // Keep these as actual runner failures, including its ordinary worker restart policy.
        await expect(page.locator('#missing')).toBeVisible({ timeout: configuration.expectedFailureTimeoutMilliseconds });
      } else throw new Error(`Unknown workload: ${workload}`);
    });
  }
}
