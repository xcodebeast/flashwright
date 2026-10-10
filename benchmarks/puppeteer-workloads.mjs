import assert from 'node:assert/strict';

/** Native Puppeteer operations on the same application fixture as the reference flows. */
export async function preparePuppeteerWorkload(name, browser, origin, configuration) {
  let iteration = 0;
  let createdContexts = 0;
  const newContext = async () => {
    const context = await browser.createBrowserContext();
    createdContexts++;
    return context;
  };
  async function expectText(page, selector, expected) {
    const result = await page.waitForFunction((selector, expected) => {
      const elements = document.querySelectorAll(selector);
      return elements.length === 1 && elements[0].textContent === expected;
    }, { polling: 'mutation', timeout: 5000 }, selector, expected);
    await result.dispose();
  }
  if (name === 'setup') {
    return {
      async run() {
        const context = await newContext();
        try {
          const page = await context.newPage();
          await page.goto(`${origin}/fixture`);
          await expectText(page, '[role="status"]', 'Ready');
        } finally { await context.close(); }
      },
      async close() {},
      async observe() { return { freshContexts: createdContexts }; },
    };
  }
  const context = await newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`${origin}/fixture`);
    const increment = page.locator('::-p-aria([name="Increment"][role="button"])');
    const operations = {
      async noop() { assert.equal(await page.evaluate(() => 42), 42); },
      async interaction() {
        await increment.click();
        await expectText(page, '#count', String(++iteration));
        assert.equal(await page.evaluate(() => window.observations.clicks.at(-1)), true);
      },
      async assertion() {
        await page.evaluate(delay => window.delayStatus(delay), configuration.delayedAssertionMilliseconds);
        await expectText(page, '[role="status"]', 'Ready');
        return { detectionLagUpperBoundMilliseconds: await page.evaluate(() => performance.now() - window.observations.readyAt) };
      },
      async navigation() {
        const response = await page.goto(`${origin}/fixture?iteration=${++iteration}`);
        assert.equal(response.status(), 200);
        const title = await page.waitForFunction(() => document.title === 'Flashwright baseline', { polling: 'mutation', timeout: 5000 });
        await title.dispose();
        await expectText(page, '[role="status"]', 'Ready');
      },
      async backend() {
        const name = `person-${++iteration}`;
        await page.locator('::-p-aria([name="Name"])').fill(name);
        const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/profile'));
        await page.locator('::-p-aria([name="Save"][role="button"])').click();
        assert.equal((await responsePromise).status(), 200);
        await expectText(page, '[role="status"]', `Saved ${name}`);
        assert.equal(await page.evaluate(() => window.observations.clicks.at(-1)), true);
      },
      async failure() {
        await assert.rejects(page.waitForSelector('#missing', { visible: true, timeout: configuration.expectedFailureTimeoutMilliseconds }), error => error.name === 'TimeoutError' && error.message.includes('#missing'));
      },
    };
    assert.ok(operations[name], `Unknown workload: ${name}`);
    return {
      run: operations[name],
      close: () => context.close(),
      observe: () => page.evaluate(() => ({
        trustedClicks: window.observations.clicks.filter(Boolean).length,
        untrustedClicks: window.observations.clicks.filter(trusted => !trusted).length,
        trustedChanges: window.observations.changes.filter(Boolean).length,
        untrustedChanges: window.observations.changes.filter(trusted => !trusted).length,
        applicationCount: window.observations.count,
        viewport: { width: innerWidth, height: innerHeight },
        visibilityState: document.visibilityState,
        focused: document.hasFocus(),
      })),
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}
