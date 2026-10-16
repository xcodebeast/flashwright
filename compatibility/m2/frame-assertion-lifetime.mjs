import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium as reference } from 'playwright';
import { expect as referenceExpect } from '../../packages/flashwright-runner/dist/upstream/test.mjs';
import { chromium as candidate } from 'flashwright';
import { expect as candidateExpect } from '@flashwright/test';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { readEngineConfiguration } from '../../tools/engine-configuration.mjs';

const destination = resolve(process.argv[2]); await mkdir(destination);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', sources: await sourceManifest(),
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH),
  driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)),
  engineConfiguration: readEngineConfiguration(),
  runtime: process.versions.bun ? `bun ${process.versions.bun}` : process.version,
  scope: 'Lazy frame assertion ancestry, blocked old renderer, original timeout diagnostics and unbounded owner closure. Shared functional controls, not a performance comparison.', cases: [] };
assert.equal(report.browser.distribution, 'full-chromium');
let port;
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(request.url === '/a' || request.url === '/b' ? '<p>before</p>' :
    `<iframe name="a" id="a" class="selected" src="http://localhost:${port}/a"></iframe><iframe name="b" id="b" src="http://127.0.0.2:${port}/b"></iframe>`);
});
server.listen(0); await once(server, 'listening'); port = server.address().port;
try {
  for (const [engine, chromium, expect] of [['playwright', reference, referenceExpect], ['flashwright', candidate, candidateExpect]]) {
    const browser = await chromium.launch({ executablePath: report.browser.executablePath });
    try {
      for (const scenario of ['lazy-live-switch', 'captured-frame-control', 'blocked-live-switch', 'blocked-timeout', 'unbounded-owner-close']) {
        const context = await browser.newContext();
        try {
          const page = await context.newPage(); await page.goto(`http://127.0.0.1:${port}/`);
          const a = page.frame('a'), b = page.frame('b'); assert(a && b);
          if (engine === 'playwright') {
            const session = await context.newCDPSession(page);
            try {
              const { targetInfos } = await session.send('Target.getTargets');
              for (const url of [`http://localhost:${port}/a`, `http://127.0.0.2:${port}/b`]) {
                assert(targetInfos.some(target => target.type === 'iframe' && target.url === url));
              }
            } finally { await session.detach(); }
          } else {
            for (const name of ['a', 'b']) await assert.rejects(page.frameLocator('#' + name).locator('p').ariaSnapshot(),
              error => error.name === 'UnsupportedFeatureError' && /out-of-process/.test(error.message));
          }
          await expect(a.locator('p')).toHaveText('before');
          await expect(b.locator('p')).toHaveText('before');
          const row = { engine, scenario, remotePlacement: true };
          report.cases.push(row);
          if (scenario === 'lazy-live-switch' || scenario === 'captured-frame-control') {
            const epoch = Date.now() + 150;
            await a.evaluate(epoch => setTimeout(() => document.querySelector('p').textContent = 'ready', epoch + 60 - Date.now()), epoch);
            await b.evaluate(epoch => setTimeout(() => document.querySelector('p').textContent = 'ready', epoch + 350 - Date.now()), epoch);
            await page.evaluate(epoch => setTimeout(() => {
              document.querySelector('#a').className = ''; document.querySelector('#b').className = 'selected';
            }, epoch - Date.now()), epoch);
            assert(Date.now() < epoch, 'arm before the ancestor changes');
            await expect(scenario === 'lazy-live-switch' ? page.frameLocator('iframe.selected').locator('p') : a.locator('p')).toHaveText('ready', { timeout: 2500 });
            assert.equal(await page.locator('iframe.selected').getAttribute('id'), 'b');
            assert.equal(a.isDetached(), false); assert.equal(b.isDetached(), false);
            row.selectedValue = await b.locator('p').textContent();
            assert.equal(row.selectedValue, scenario === 'lazy-live-switch' ? 'ready' : 'before');
          } else {
            if (scenario === 'blocked-live-switch') await b.evaluate(() => document.querySelector('p').textContent = 'ready');
            const epoch = Date.now() + 200;
            await a.evaluate(epoch => setTimeout(() => { while (true) {} }, epoch - Date.now()), epoch);
            if (scenario === 'blocked-live-switch') await page.evaluate(epoch => setTimeout(() => {
              document.querySelector('#a').className = ''; document.querySelector('#b').className = 'selected';
            }, epoch + 20 - Date.now()), epoch);
            assert(Date.now() < epoch, 'arm before the old child blocks');
            const pending = expect(page.frameLocator('iframe.selected').locator('p')).toHaveText('ready',
              { timeout: scenario === 'unbounded-owner-close' ? 0 : 800 }).then(() => ({ success: true }), error => ({ success: false, message: error.message }));
            if (scenario === 'unbounded-owner-close') {
              await new Promise(resolve => setTimeout(resolve, 450)); await context.close();
            }
            row.outcome = await pending;
            if (scenario === 'blocked-live-switch') {
              assert.equal(row.outcome.success, true);
              assert.equal(await b.locator('p').textContent(), 'ready');
              assert.equal(await page.locator('iframe.selected').getAttribute('id'), 'b');
            } else {
              assert.equal(row.outcome.success, false);
              if (scenario === 'blocked-timeout') {
                assert.match(row.outcome.message, /ready/); assert.match(row.outcome.message, /before/);
              } else assert.equal(page.isClosed(), true);
            }
          }
          row.status = 'passed';
        } finally { await context.close(); }
      }
      // The public matcher formats errors. Inspect the underlying protocol error as
      // well so an earlier lease's outstanding cancellation cannot be silently lost.
      if (engine === 'flashwright') {
        const context = await browser.newContext();
        try {
          const page = await context.newPage(); await page.goto(`http://127.0.0.1:${port}/`);
          await expect(page.frameLocator('#a').locator('p')).toHaveText('before');
          await page.frame('a').evaluate(() => setTimeout(() => { while (true) {} }, 200));
          const request = JSON.stringify({ selector: 'css=#a >> internal:control=enter-frame >> css=p', expectedText: [{ string: 'ready', normalizeWhiteSpace: true }] });
          await assert.rejects(browser.client.request('assertion.run', {
            page: page.identifier, frame: page.mainFrame().snapshot.identifier, expression: 'to.have.text', isNot: false,
            request: Array.from(request, character => character.charCodeAt(0)),
          }, 600), error => {
            assert.equal(error.name, 'TimeoutError');
            if (report.engineConfiguration.residentAssertions && report.engineConfiguration.frameAssertionLeases !== false) {
              assert.equal(error.details.cleanup, 'residentCancellationPending');
            }
            assert.equal(String.fromCharCode(...error.details.diagnostics.received.units), 'before');
            report.cases.push({ engine, scenario: 'pending-cleanup-diagnostic', cleanup: error.details.cleanup, status: 'passed' });
            return true;
          });
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  assert.equal(hash(await readFile(report.browser.executablePath)), report.browser.sha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ status: report.status, cases: report.cases.length, error: report.error }));
