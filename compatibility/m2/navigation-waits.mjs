import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';
import { createHttpFixture } from '../../tools/http-fixture.mjs';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';

const destination = `compatibility/evidence/navigation-waits-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { status: 'running', schemaVersion: 1, reference: '1.60.0', ...runtimeMetadata, sources: await sourceManifest(), browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()), driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), outcomes: {}, candidateChecks: [], scope: 'Page navigation waiters, host URL matchers, invocation order, immutable URL/response attribution and owned-page lifecycle. No performance claim.' };
let heldImage;
const fixture = createHttpFixture((request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname;
  if (path === '/stall-image') return;
  if (path === '/controlled-image') { heldImage = response; return; }
  if (path === '/failure') { request.socket.destroy(); return; }
  if (path === '/redirect') { response.writeHead(302, { location: '/final' }); response.end(); return; }
  response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'x-path': path });
  response.end(`<!doctype html><title>${path}</title><body>${path}<a href="/clicked">navigate</a>${path === '/parent' ? '<iframe name="child" src="/child"></iframe>' : ''}${path === '/wait-state' ? '<img src="/controlled-image">' : ''}${path === '/auto-first' ? '<img src="/stall-image"><script>setTimeout(() => location.href = "/auto-second", 50)</script>' : ''}`);
});
fixture.server.listen(0, '127.0.0.1'); await once(fixture.server, 'listening');
const origin = `http://127.0.0.1:${fixture.server.address().port}`;
async function waitForHeldImage() {
  const deadline = Date.now() + 4000;
  while (!heldImage) { assert.ok(Date.now() < deadline, 'controlled image must be requested'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function run(name, chromium) {
  const outcomes = report.outcomes[name] = {};
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  try {
    const context = await browser.newContext({ baseURL: origin });
    context.setDefaultNavigationTimeout(4000);
    const page = await context.newPage(); await page.goto('/initial');
    const observed = [];
    for (let index = 0; index < 12; index++) {
      const [response] = await Promise.all([
        page.waitForNavigation({ timeout: 1000, waitUntil: 'commit' }),
        page.evaluate(index => { location.href = `/immediate-${index}`; }, index),
      ]);
      observed.push(new URL(response.url()).pathname);
      assert.equal((await response.text()).includes(`/immediate-${index}`), true);
      await page.waitForLoadState();
    }
    outcomes.immediateTriggers = observed;
    const [clicked] = await Promise.all([page.waitForNavigation({ url: '**/clicked' }), page.getByRole('link', { name: 'navigate' }).click()]);
    assert.equal(new URL(clicked.url()).pathname, '/clicked'); outcomes.click = clicked.status();
    const paths = [];
    const matching = page.waitForNavigation({ url: url => { paths.push(url.pathname); return url.pathname === '/selected'; } });
    const any = page.waitForNavigation();
    await page.evaluate(() => { history.pushState({}, '', '/skipped'); history.pushState({}, '', '/selected'); });
    assert.equal(await matching, null); assert.equal(await any, null);
    assert.deepEqual(paths, ['/skipped', '/selected']); outcomes.immutablePaths = paths;
    const hashWait = page.waitForNavigation({ url: /#chosen$/ });
    await page.evaluate(() => { location.hash = 'chosen'; }); assert.equal(await hashWait, null);
    outcomes.sameDocument = new URL(page.url()).hash;
    const [redirected] = await Promise.all([page.waitForNavigation({ url: '/final' }), page.goto('/redirect')]);
    assert.equal(new URL(redirected.url()).pathname, '/final'); outcomes.redirect = redirected.headers()['x-path'];
    await page.waitForURL('/final'); await page.waitForURL(url => url.pathname === '/final', { waitUntil: 'commit' });
    const futureURL = page.waitForURL('**/future#done');
    await page.evaluate(() => { history.pushState({}, '', '/future#done'); }); assert.equal(await futureURL, undefined);
    outcomes.waitForURL = new URL(page.url()).pathname;
    const [selectedBeforeReplacement] = await Promise.all([
      page.waitForNavigation({ url: '**/auto-first' }),
      page.goto('/auto-first', { waitUntil: 'commit' }),
    ]);
    await page.waitForURL('/auto-second');
    outcomes.documentReplacement = new URL(selectedBeforeReplacement.url()).pathname;
    assert.equal(outcomes.documentReplacement, '/auto-first');
    for (const waitUntil of ['commit', 'domcontentloaded', 'load', 'networkidle']) {
      await page.goto('/state-start'); heldImage = undefined;
      let settled = false;
      const waiting = page.waitForNavigation({ waitUntil }).then(response => { settled = true; return response; });
      await page.goto('/wait-state', { waitUntil: 'commit' });
      if (waitUntil === 'commit' || waitUntil === 'domcontentloaded') assert.equal((await waiting).status(), 200);
      await waitForHeldImage();
      if (waitUntil === 'load' || waitUntil === 'networkidle') assert.equal(settled, false);
      heldImage.end('image'); await waiting; await page.waitForLoadState();
    }
    outcomes.lifecycle = ['commit', 'domcontentloaded', 'load', 'networkidle'];
    heldImage = undefined; await page.goto('/wait-state', { waitUntil: 'commit' });
    let matchingURLSettled = false;
    const matchingURL = page.waitForURL('/wait-state').then(() => { matchingURLSettled = true; });
    await waitForHeldImage(); assert.equal(matchingURLSettled, false);
    heldImage.end('image'); await matchingURL;
    outcomes.currentURLWaitsForLoad = true;
    const sentinel = new Error('URL callback sentinel');
    const failingCallback = assert.rejects(page.waitForNavigation({ url: () => { throw sentinel; } }), error => error === sentinel);
    await page.evaluate(() => { history.pushState({}, '', '/callback'); }); await failingCallback;
    outcomes.callbackFailure = true;
    await assert.rejects(page.waitForNavigation({ timeout: 30 }), error => error.name === 'TimeoutError');
    await assert.rejects(page.waitForURL('/never', { timeout: 30 }), error => error.name === 'TimeoutError');
    outcomes.deadlines = true;

    if (typeof globalThis.URLPattern === 'function') {
      const pattern = new URLPattern({ pathname: '/pattern/:identifier' });
      const patternWait = page.waitForNavigation({ url: pattern });
      await page.evaluate(() => { history.pushState({}, '', '/pattern/42'); }); assert.equal(await patternWait, null);
      await page.waitForURL(pattern);
      await page.goto('/parent');
      assert.equal(page.frame({ url: new URLPattern({ pathname: '/child' }) }).name(), 'child');
      outcomes.nativeURLPattern = ['navigation', 'URL', 'frame'];
    }
    const rejectedFailure = assert.rejects(page.waitForNavigation({ url: '/does-not-match-error' }), error => /ERR_EMPTY_RESPONSE|ERR_CONNECTION/.test(error.message));
    const errorDocument = page.waitForEvent('framenavigated');
    await assert.rejects(page.goto('/failure'));
    await rejectedFailure; await errorDocument; await page.waitForLoadState();
    await page.goto('/recovered');
    const afterFailure = page.waitForNavigation();
    await page.evaluate(() => { history.pushState({}, '', '/after-observed-failure'); }); assert.equal(await afterFailure, null);
    outcomes.networkFailure = 'fails independent of URL filter and is not replayed';
    const unlimited = assert.rejects(page.waitForNavigation({ timeout: 0 }), error => /closed|TargetClosed/.test(error.message));
    await page.close(); await unlimited;
    outcomes.close = true;
    if (name === 'flashwright') {
      const validation = await context.newPage(); await validation.goto('/validation');
      for (const options of [{ waitUntil: 'invalid' }, { timeout: -1 }, { unexpected: true }]) {
        await assert.rejects(validation.waitForNavigation(options), error => ['InvalidArgumentError', 'UnsupportedFeatureError'].includes(error.name));
      }
      if (typeof globalThis.URLPattern === 'function') await assert.rejects(validation.waitForResponse(new URLPattern({ pathname: '/response' })), error => error.name === 'InvalidArgumentError');
      report.candidateChecks.push('Unsupported options and invalid wait states/deadlines reject before arming');
    }
  } finally { await browser.close(); }
}
try {
  await run('playwright', referenceChromium); await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.playwright);
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error; }
finally { await fixture.close(); await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(`Navigation-wait evidence: ${destination}/report.json`); }
