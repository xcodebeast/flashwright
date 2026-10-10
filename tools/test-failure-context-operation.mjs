import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'flashwright';
import { runtimeMetadata } from './javascript-runtime.mjs';

const require = createRequire(import.meta.url);
const { runnerIntegration } = require('../packages/flashwright-core/dist/commonjs/runner-integration.js');
const capture = (page, timeout = 1000) => runnerIntegration.captureFailureContextSnapshot(13, page, timeout);
const checks = [];
async function check(name, callback) { await callback(); checks.push(name); }
const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.evaluate(() => { document.body.innerHTML = '<h1>Original document</h1>'; });
  await check('private version, ownership and finite budget reject before native dispatch', async () => {
    assert.throws(() => runnerIntegration.captureFailureContextSnapshot(12, page, 1000), { name: 'ProtocolError' });
    await assert.rejects(capture({}), { name: 'InvalidArgumentError' });
    for (const timeout of [0, -1, NaN, Infinity, 5001, '100']) await assert.rejects(capture(page, timeout), { name: 'InvalidArgumentError' });
    assert.match(await capture(page), /Original document/);
  });
  await check('native route rejects a foreign frame and unknown keys', async () => {
    await assert.rejects(browser.client.request('diagnostics.pageSnapshot', { page: page.identifier, frame: 'foreign-frame' }, 1000), { name: 'InvalidArgumentError' });
    await assert.rejects(browser.client.request('diagnostics.pageSnapshot', { page: page.identifier, frame: page.mainFrameIdentifier, mode: 'ai' }, 1000), { name: 'UnsupportedFeatureError' });
  });
  await check('blocked renderer obeys caller deadline and recovers without a late snapshot', async () => {
    const source = 'while (true) {}';
    const blocked = browser.client.request('page.evaluate', {
      page: page.identifier, source: Array.from(source, character => character.charCodeAt(0)), isFunction: false, argument: { kind: 'undefined' },
    }, 600).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 30));
    const started = performance.now();
    await assert.rejects(capture(page, 80), { name: 'TimeoutError' });
    assert.ok(performance.now() - started < 500, 'diagnostic waited for blocked renderer');
    assert.equal((await blocked).name, 'TimeoutError');
    assert.match(await capture(page), /Original document/);
  });
  await check('missing body retries within the original operation', async () => {
    await page.evaluate(() => {
      document.body.remove();
      setTimeout(() => { const body = document.createElement('body'); body.innerHTML = '<h1>Recovered body</h1>'; document.documentElement.appendChild(body); }, 80);
    });
    assert.match(await capture(page), /Recovered body/);
  });
  await check('native five-second ceiling survives an unbounded caller', async () => {
    await page.evaluate(() => document.body.remove());
    const started = performance.now();
    await assert.rejects(browser.client.request('diagnostics.pageSnapshot', { page: page.identifier, frame: page.mainFrameIdentifier }, 0), { name: 'TimeoutError' });
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 4500 && elapsed < 6500, `native diagnostic ceiling: ${elapsed}`);
  });
  await check('context closure settles the original pending capture and successor remains healthy', async () => {
    const pending = capture(page, 5000).catch(error => error);
    await page.evaluate(() => 1);
    await context.close();
    assert.equal((await pending).name, 'TargetClosedError');
    await assert.rejects(capture(page), { name: 'TargetClosedError' });
    const successor = await browser.newPage();
    await successor.evaluate(() => { document.body.innerHTML = '<h1>Successor document</h1>'; });
    assert.match(await capture(successor), /Successor document/);
    await successor.close();
  });
} finally { await browser.close(); }
console.log(JSON.stringify({ status: 'passed', ...runtimeMetadata, checks }, null, 2));
