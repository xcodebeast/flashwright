import assert from 'node:assert/strict';

/** Each timed operation verifies semantic outcomes; setup and warm-up remain accounted for. */
export async function prepareWorkload(name, browser, origin, expect, configuration) {
  let iteration = 0;
  let createdContexts = 0;
  const createContext = async () => {
    const context = await browser.newContext({ viewport: configuration.viewport, baseURL: origin });
    createdContexts++;
    return context;
  };
  if (name === 'setup') {
    return {
      async run() {
        const context = await createContext();
        try {
          const page = await context.newPage();
          await page.goto('/fixture');
          await expect(page.getByRole('status')).toHaveText('Ready');
        } finally { await context.close(); }
      },
      async close() {},
      async observe() { return { freshContexts: createdContexts }; },
      accounting: { description: 'Fresh context + page + navigation + assertion + disposal per iteration', publicCallsPerIteration: 5 },
    };
  }
  const context = await createContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto('/fixture');
  const increment = page.getByRole('button', { name: 'Increment', exact: true });
  const status = page.getByRole('status');
  const operations = {
    async noop() { assert.equal(await page.evaluate(() => 42), 42); },
    async interaction() {
      await increment.click();
      await expect(page.locator('#count')).toHaveText(String(++iteration));
      assert.equal(await page.evaluate(() => window.observations.clicks.at(-1)), true);
    },
    async assertion() {
      await page.evaluate(delay => window.delayStatus(delay), configuration.delayedAssertionMilliseconds);
      await expect(status).toHaveText('Ready');
      const lag = await page.evaluate(() => performance.now() - window.observations.readyAt);
      return { detectionLagUpperBoundMilliseconds: lag };
    },
    async navigation() {
      const response = await page.goto(`/fixture?iteration=${++iteration}`);
      assert.equal(response.status(), 200);
      await expect(page).toHaveTitle('Flashwright baseline');
      await expect(status).toHaveText('Ready');
    },
    async backend() {
      const name = `person-${++iteration}`;
      await page.getByLabel('Name').fill(name);
      const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/profile'));
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const response = await responsePromise;
      assert.equal(response.status(), 200);
      await expect(status).toHaveText(`Saved ${name}`);
      assert.equal(await page.evaluate(() => window.observations.clicks.at(-1)), true);
    },
    async failure() {
      await assert.rejects(
        expect(page.locator('#missing')).toBeVisible({ timeout: configuration.expectedFailureTimeoutMilliseconds }),
        error => error.message.includes('toBeVisible') && error.message.includes('#missing'),
      );
    },
  };
  if (!operations[name]) throw new Error(`Unknown workload: ${name}`);
  return {
    run: operations[name], close: () => context.close(),
    observe: () => page.evaluate(() => ({
      trustedClicks: window.observations.clicks.filter(Boolean).length,
      untrustedClicks: window.observations.clicks.filter(trusted => !trusted).length,
      trustedChanges: window.observations.changes.filter(Boolean).length,
      untrustedChanges: window.observations.changes.filter(trusted => !trusted).length,
      applicationCount: window.observations.count,
      viewport: { width: innerWidth, height: innerHeight },
      focused: document.hasFocus(), visibilityState: document.visibilityState,
    })),
    accounting: {
      publicCallsPerIteration: { noop: 1, interaction: 3, assertion: 3, navigation: 3, backend: 5, failure: 1 }[name],
      description: 'Includes outcome verification calls; protocol/evaluation internals are not instrumented in baseline timing.',
    },
  };
}
