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

const destination = `compatibility/evidence/history-navigation-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { status: 'running', schemaVersion: 1, reference: '1.60.0', ...runtimeMetadata, sources: await sourceManifest(), browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()), driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), outcomes: {}, candidateChecks: [], scope: 'reload, goBack and goForward on owned Chromium pages, including same-document traversal, response identity, lifecycle, timeout and close. No performance claim.' };
const requests = new Map();
const waiting = new Map();
let holdDocument = false;
let failDocument = false;
let slowImage = false;
const fixture = createHttpFixture((request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname;
  requests.set(path, (requests.get(path) ?? 0) + 1);
  response.setHeader('cache-control', 'no-store');
  if (path === '/failure' && failDocument) { request.socket.destroy(); return; }
  if (path === '/held' && holdDocument) { waiting.set('document', response); return; }
  if (path === '/image' && slowImage) { waiting.set('image', response); return; }
  if (path === '/redirect') { response.writeHead(302, { location: '/final' }); response.end(); return; }
  response.writeHead(path === '/status' ? 201 : 200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'x-history': path });
  response.end(`<!doctype html><title>${path}</title><body>${path}<script>globalThis.applicationSeed=globalThis.initSeed??null</script>${path === '/lifecycle' ? '<img src="/image">' : ''}`);
});
fixture.server.listen(0, '127.0.0.1'); await once(fixture.server, 'listening');
const origin = `http://127.0.0.1:${fixture.server.address().port}`;
const pathname = page => new URL(page.url()).pathname + new URL(page.url()).hash;
async function observe(condition, description) {
  const deadline = Date.now() + 5000;
  while (!condition()) { assert.ok(Date.now() < deadline, description); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function describe(response) {
  if (!response) return null;
  return { path: new URL(response.url()).pathname, status: response.status(), header: response.headers()['x-history'], bodyHasPath: (await response.text()).includes(new URL(response.url()).pathname), navigation: response.request().isNavigationRequest() };
}
async function run(name, chromium) {
  const outcomes = report.outcomes[name] = {};
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(4000);
    assert.equal(await page.goBack(), null); assert.equal(await page.goForward(), null);
    assert.equal(await page.reload(), null);
    outcomes.blank = 'boundary and reload return null';
    await page.addInitScript(() => { globalThis.initSeed = 'preloaded'; });
    await page.goto(origin + '/first'); await page.goto(origin + '/status');
    outcomes.reload = await describe(await page.reload());
    assert.deepEqual(outcomes.reload, { path: '/status', status: 201, header: '/status', bodyHasPath: true, navigation: true });
    assert.equal(await page.evaluate(() => globalThis.applicationSeed), 'preloaded');
    outcomes.back = await describe(await page.goBack()); assert.equal(pathname(page), '/first');
    outcomes.forward = await describe(await page.goForward()); assert.equal(pathname(page), '/status');
    assert.equal(await page.goForward(), null);
    await page.goto('about:blank');
    assert.equal((await page.goBack()).status(), 201);
    assert.equal(await page.goForward(), null); assert.equal(page.url(), 'about:blank');
    assert.equal((await page.goBack()).status(), 201);
    outcomes.nonNetworkDocument = 'explicit about:blank traversal returns null';
    await page.evaluate(() => { history.pushState({}, '', '#one'); history.pushState({}, '', '#two'); history.replaceState({}, '', '#replaced'); });
    assert.equal(await page.goBack(), null); assert.equal(pathname(page), '/status#one');
    assert.equal(await page.goBack(), null); assert.equal(pathname(page), '/status');
    assert.equal(await page.goForward(), null); assert.equal(pathname(page), '/status#one');
    assert.equal(await page.goForward(), null); assert.equal(pathname(page), '/status#replaced');
    outcomes.sameDocument = pathname(page);
    await page.goto(origin + '/redirect');
    outcomes.redirectReload = await describe(await page.reload()); assert.equal(outcomes.redirectReload.path, '/final');
    await page.goBack(); assert.equal(pathname(page), '/status#replaced');
    outcomes.redirectForward = await describe(await page.goForward()); assert.equal(outcomes.redirectForward.path, '/final');

    // A reload must not complete on a pushState in the outgoing document.
    await page.goto(origin + '/held'); holdDocument = true; waiting.delete('document');
    await page.evaluate(() => setTimeout(() => history.pushState({}, '', '#stray'), 100));
    let strayNavigation = false;
    const observeStray = frame => { if (frame.url().endsWith('#stray')) strayNavigation = true; };
    page.on('framenavigated', observeStray);
    let settled = false;
    const reloading = page.reload().then(value => { settled = true; return value; });
    await observe(() => waiting.has('document'), 'reload reached held server');
    reloading.catch(() => {});
    await observe(() => strayNavigation, 'outgoing document changed history');
    page.off('framenavigated', observeStray);
    assert.equal(settled, false);
    waiting.get('document').end('<!doctype html><title>released</title>'); holdDocument = false;
    assert.equal((await reloading).status(), 200); assert.equal(pathname(page), '/held');
    outcomes.reloadIgnoresSameDocument = true;

    // Commit and DOMContentLoaded can finish before an image; load cannot.
    for (const waitUntil of ['commit', 'domcontentloaded', 'load', 'networkidle']) {
      slowImage = false; await page.goto(origin + '/lifecycle'); slowImage = true; waiting.delete('image');
      let finished = false;
      const pending = page.reload({ waitUntil }).then(response => { finished = true; return response; });
      if (waitUntil === 'commit' || waitUntil === 'domcontentloaded') { assert.equal((await pending).status(), 200); }
      await observe(() => waiting.has('image'), 'image requested');
      if (waitUntil === 'load' || waitUntil === 'networkidle') { assert.equal(finished, false); }
      waiting.get('image').end('image'); slowImage = false;
      assert.equal((await pending).status(), 200); await page.waitForLoadState();
    }
    outcomes.lifecycle = ['commit', 'domcontentloaded', 'load', 'networkidle'];

    // Deadline ends the waiter, never replays a dispatched reload or history action.
    await page.goto(origin + '/held'); holdDocument = true; waiting.delete('document');
    const beforeReload = requests.get('/held');
    await assert.rejects(page.reload({ timeout: 150 }), error => error.name === 'TimeoutError');
    assert.equal(requests.get('/held'), beforeReload + 1);
    const lateReload = page.waitForEvent('framenavigated');
    waiting.get('document').end('<!doctype html><title>late reload</title>'); holdDocument = false;
    await lateReload; await page.waitForLoadState(); await page.goto(origin + '/after-timeout');
    assert.equal(requests.get('/held'), beforeReload + 1);
    holdDocument = true; waiting.delete('document'); const beforeBack = requests.get('/held');
    await assert.rejects(page.goBack({ timeout: 150 }), error => error.name === 'TimeoutError');
    assert.equal(requests.get('/held'), beforeBack + 1);
    const lateBack = page.waitForEvent('framenavigated');
    waiting.get('document').end('<!doctype html><title>late back</title>'); holdDocument = false;
    await lateBack; await page.waitForLoadState();
    assert.equal((await page.goForward()).status(), 200); assert.equal(pathname(page), '/after-timeout');
    assert.equal(requests.get('/held'), beforeBack + 1);
    outcomes.timeout = 'reload and back dispatched once and subsequent navigation remains usable';

    await page.goto(origin + '/failure'); failDocument = true;
    const errorDocument = page.waitForEvent('framenavigated');
    await assert.rejects(page.reload(), error => /ERR_EMPTY_RESPONSE|ERR_CONNECTION|Navigation/.test(error.message));
    await errorDocument; await page.waitForLoadState();
    failDocument = false; await page.goto(origin + '/recovery');
    outcomes.networkFailure = pathname(page);
    await page.goto(origin + '/held'); holdDocument = true; waiting.delete('document');
    const closeWait = page.reload({ timeout: 0 }); const rejected = assert.rejects(closeWait, error => /closed|TargetClosed|ERR_ABORTED/.test(error.message));
    await observe(() => waiting.has('document'), 'closing reload reached server'); await page.close(); await rejected; holdDocument = false;
    const sibling = await browser.newPage(); await sibling.goto(origin + '/sibling'); assert.equal(pathname(sibling), '/sibling');
    outcomes.close = 'pending reload releases and sibling remains usable';
    if (name === 'flashwright') {
      for (const method of ['reload', 'goBack', 'goForward']) {
        for (const options of [{ referer: origin }, { waitUntil: 'invalid' }, { timeout: -1 }]) {
          await assert.rejects(sibling[method](options), error => ['InvalidArgumentError', 'UnsupportedFeatureError'].includes(error.name));
        }
      }
      report.candidateChecks.push('Unknown options and invalid wait states/deadlines fail explicitly');
    }
  } finally { holdDocument = false; failDocument = false; slowImage = false; await browser.close(); }
}
try {
  await run('playwright', referenceChromium); await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.playwright);
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error; }
finally { await fixture.close(); await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(`History evidence: ${destination}/report.json`); }
