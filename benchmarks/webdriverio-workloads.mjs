import assert from 'node:assert/strict';

/** Attempt every removal and retain the operation failure alongside cleanup failures. */
export async function closeWebdriverContexts(contexts, operationError) {
  const results = await Promise.allSettled(contexts.map(context => Promise.resolve().then(() => context.close())));
  const errors = [...(operationError ? [operationError] : []), ...results.filter(result => result.status === 'rejected').map(result => result.reason)];
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, errors.map(error => error?.stack ?? String(error)).join('\n'));
}

/** Create a separate BiDi user context, then expose WebdriverIO's native page commands. */
export async function createWebdriverPage(browser, viewport) {
  const userContext = await browser.browserCreateUserContext({});
  try {
    const created = await browser.browsingContextCreate({ type: 'tab', userContext: userContext.userContext });
    const page = (await browser.browsingContexts()).find(context => context.contextId === created.context);
    assert.ok(page, 'Created BiDi context must appear in the public context inventory');
    await page.setViewport(viewport);
    return { page, close: () => browser.browserRemoveUserContext(userContext) };
  } catch (error) {
    await closeWebdriverContexts([{ close: () => browser.browserRemoveUserContext(userContext) }], error);
  }
}

/** Native WebdriverIO polling and inputs; assertions apply only to this fixed fixture. */
export async function prepareWebdriverWorkload(name, browser, origin, configuration) {
  let iteration = 0;
  let createdContexts = 0;
  const create = async () => { const context = await createWebdriverPage(browser, configuration.viewport); createdContexts++; return context; };
  const expectText = (page, selector, expected) => page.waitUntil(async () => {
    const elements = await page.$$(selector);
    return elements.length === 1 && await elements[0].getText() === expected;
  }, { timeout: 5000, timeoutMsg: `Expected unique ${selector} to have text ${expected}` });
  if (name === 'setup') return {
    async run() {
      const context = await create();
      let failure;
      try { await context.page.navigate(`${origin}/fixture`); await expectText(context.page, '[role="status"]', 'Ready'); }
      catch (error) { failure = error; }
      await closeWebdriverContexts([context], failure);
    },
    async close() {},
    async observe() { return { freshContexts: createdContexts }; },
  };
  const context = await create();
  const { page } = context;
  const responses = [];
  const responseListener = event => {
    if (event.context === page.contextId && event.request.url === `${origin}/api/profile`) responses.push(event.response.status);
  };
  browser.on('network.responseCompleted', responseListener);
  try {
    await page.navigate(`${origin}/fixture`);
    const operations = {
      async noop() { assert.equal(await page.execute(() => 42), 42); },
      async interaction() {
        await page.$('aria/Increment').click();
        await expectText(page, '#count', String(++iteration));
        assert.equal(await page.execute(() => window.observations.clicks.at(-1)), true);
      },
      async assertion() {
        await page.execute(delay => window.delayStatus(delay), configuration.delayedAssertionMilliseconds);
        await expectText(page, '[role="status"]', 'Ready');
        return { detectionLagUpperBoundMilliseconds: await page.execute(() => performance.now() - window.observations.readyAt) };
      },
      async navigation() {
        await page.navigate(`${origin}/fixture?iteration=${++iteration}`);
        assert.equal(page.request?.response?.status, 200);
        await page.waitUntil(async () => await page.getTitle() === 'Flashwright baseline', { timeout: 5000 });
        await expectText(page, '[role="status"]', 'Ready');
      },
      async backend() {
        const name = `person-${++iteration}`;
        await page.$('aria/Name').setValue(name);
        await page.$('aria/Save').click();
        await expectText(page, '[role="status"]', `Saved ${name}`);
        await page.waitUntil(() => responses.length === iteration, { timeout: 5000 });
        assert.equal(responses[iteration - 1], 200);
        assert.equal(await page.execute(() => window.observations.clicks.at(-1)), true);
      },
      async failure() {
        await assert.rejects(page.$('#missing').waitForDisplayed({ timeout: configuration.expectedFailureTimeoutMilliseconds }), error => error.message.includes('#missing') && error.message.includes('still not displayed'));
      },
    };
    assert.ok(operations[name], `Unknown workload: ${name}`);
    return {
      run: operations[name],
      async close() { browser.off('network.responseCompleted', responseListener); await context.close(); },
      observe: () => page.execute(() => ({
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
    browser.off('network.responseCompleted', responseListener);
    await closeWebdriverContexts([context], error);
  }
}
