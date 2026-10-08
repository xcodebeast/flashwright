import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium as referenceChromium } from 'playwright';

/** The same public callback and document transitions run against both engines. */
export async function verifyEvaluationContexts(chromium) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Evaluation contexts</title><script>window.initialGlobals = []; window.initialGlobals = Object.getOwnPropertyNames(window).sort();</script><p>Ready</p>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [name, engine] of [['reference', referenceChromium], ['flashwright', chromium]]) {
      const browser = await engine.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
      try {
        const page = await browser.newPage();
        for (let documentIndex = 0; documentIndex < 4; documentIndex++) {
          await page.goto(`${origin}/document-${documentIndex}`);
          const results = await Promise.all(Array.from({ length: 32 }, (_, index) => page.evaluate(value => {
            globalThis.callbackCount = (globalThis.callbackCount || 0) + 1;
            return value * 2;
          }, index)));
          assert.deepEqual(results, Array.from({ length: 32 }, (_, index) => index * 2));
          assert.equal(await page.evaluate(() => callbackCount), 32);
          assert.deepEqual(await page.evaluate(() => Object.getOwnPropertyNames(window).filter(key => !initialGlobals.includes(key)).sort()), ['callbackCount']);
          assert.equal(await page.evaluate("'literal " + String.fromCharCode(0xd800) + "'"), 'literal \ud800');
          await page.goto(`${origin}/document-${documentIndex}#same-document`);
          assert.equal(await page.evaluate(() => callbackCount), 32);
        }
        const pending = page.evaluate(() => new Promise(resolve => { globalThis.completeEvaluation = resolve; }));
        await page.evaluate(async () => {
          while (!globalThis.completeEvaluation) await new Promise(resolve => setTimeout(resolve, 0));
          globalThis.completeEvaluation('completed concurrently');
        });
        assert.equal(await pending, 'completed concurrently');
        await page.evaluate(() => { window.name = '0'; });
        const navigation = page.waitForURL(`${origin}/successor`);
        const interrupted = page.evaluate(() => {
          window.name = String(Number(window.name) + 1);
          location.href = '/successor';
          return new Promise(() => {});
        });
        await assert.rejects(interrupted, /context|navigation/i);
        await navigation;
        assert.equal(await page.evaluate(() => window.name), '1', 'A lost callback reply must not replay in the successor');
        assert.deepEqual(await page.evaluate(() => Object.getOwnPropertyNames(window).filter(key => !initialGlobals.includes(key))), []);
        await page.evaluate(() => { document.open(); document.write('<p>Replacement markup</p>'); document.close(); });
        assert.equal(await page.evaluate(() => document.querySelector('p').textContent), 'Replacement markup');
        const closingEvaluation = page.evaluate(() => new Promise(() => {})).then(() => null, error => error);
        await page.evaluate(() => 'another call can finish before closure');
        await page.close();
        assert.match((await closingEvaluation).message, /closed/i);
        const replacement = await browser.newPage();
        assert.equal(await replacement.evaluate(() => 42), 42);
        await replacement.close();
        console.log(`${name}: evaluation context ownership, concurrency, Unicode source and no replay passed`);
      } finally { await browser.close(); }
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
