const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const emit = (event, info = {}) => appendFileSync(process.env.FW_TIMEOUT_EVENTS, JSON.stringify({ event, pid: process.pid, ...info }) + '\n');
exports.declare = (base, chromium) => {
  const test = base.extend({
    ownedBrowser: [async ({}, use) => {
      const browser = await chromium.launch({ executablePath: process.env.FW_TIMEOUT_BROWSER, headless: true });
      emit('browser-open');
      try { await use(browser); }
      finally { await browser.close(); emit('browser-closed'); }
    }, { scope: 'worker', timeout: 10000 }],
    screen: [async ({ ownedBrowser }, use, info) => {
      const context = await ownedBrowser.newContext();
      const screen = { context, page: await context.newPage(), pending: undefined, cancelled: false };
      try {
        await screen.page.goto(process.env.FW_TIMEOUT_URL);
        emit('context-open', { retry: info.retry });
        await use(screen);
      } finally {
        await context.close();
        await screen.pending;
        if (info.retry === 0) assert.equal(screen.cancelled, true, 'closing context rejected the original evaluation');
        emit('context-closed', { retry: info.retry });
      }
    }, { timeout: 10000 }],
  });
  test.setTimeout(500);
  test.afterEach(async ({ screen }, info) => {
    assert.equal(await screen.page.locator('button').textContent(), info.retry === 0 ? 'ready' : 'clicked');
    emit('afterEach', { retry: info.retry });
  });
  test('timeout retires browser before an isolated retry', async ({ screen }, info) => {
    if (info.retry !== 0) info.setTimeout(10000);
    const { page, context } = screen;
    assert.deepEqual(await context.cookies(), []);
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('stale'), window.stale ?? null]), [null, null]);
    emit('fresh-state', { retry: info.retry, workerIndex: info.workerIndex, parallelIndex: info.parallelIndex });
    if (info.retry === 0) {
      await context.addCookies([{ name: 'stale', value: '1', url: process.env.FW_TIMEOUT_URL }]);
      await page.evaluate(() => { localStorage.setItem('stale', '1'); window.stale = true; });
      const pending = page.evaluate(() => new Promise(() => {}));
      screen.pending = pending.then(() => assert.fail('hung evaluation unexpectedly resolved'), error => {
        assert.match(error.message, /closed|destroyed|cancel/i);
        screen.cancelled = true;
        emit('evaluation-rejected');
      });
      emit('evaluation-pending');
      await pending;
    } else {
      await page.locator('button').click();
      assert.equal(await page.evaluate(() => window.trusted), true);
      emit('trusted-click');
    }
  });
};
