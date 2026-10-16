import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';
import { createHttpFixture } from '../../tools/http-fixture.mjs';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { runtimeMetadata } from '../../tools/javascript-runtime.mjs';

const directory = resolve(process.argv[2] ?? `workbench/request-waits-${Date.now()}`);
await mkdir(directory, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const driver = process.env.FLASHWRIGHT_DRIVER_PATH;
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(), browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()), driverSha256: hash(await readFile(driver)), outcomes: {}, scope: 'Public request waits on the existing native request-event path. Matcher, invocation, identity, callback, timeout, lifecycle and trace checks; no performance claim.' };
let held;
const fixture = createHttpFixture((request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname;
  if (path === '/held') { held = response; return; }
  if (path === '/redirect') { response.writeHead(302, { location: '/redirected' }); response.end(); return; }
  response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  response.end('<!doctype html><link rel="icon" href="data:,"><title>request waits</title>');
});
fixture.server.listen(0, '127.0.0.1'); await once(fixture.server, 'listening');
const origin = `http://127.0.0.1:${fixture.server.address().port}`;
const closed = error => /closed|TargetClosed/i.test(error.message);
const timeout = error => error.name === 'TimeoutError';
async function run(name, chromium) {
  const outcomes = report.outcomes[name] = {};
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  try {
    const context = await browser.newContext({ baseURL: origin });
    context.setDefaultTimeout(4000);
    const page = await context.newPage(); await page.goto('/initial');
    const observed = []; page.on('request', request => observed.push(request));
    const trigger = path => page.evaluate(path => fetch(path).then(() => undefined), path);
    for (const [label, matcher, path] of [
      ['relative', '/relative', '/relative'], ['glob', '**/glob?*', '/glob?value=1'],
      ['regexp', /\/regexp$/, '/regexp'], ['empty', '', '/empty'],
      ['predicate', request => new URL(request.url()).pathname === '/predicate', '/predicate'],
    ]) {
      const [request] = await Promise.all([page.waitForRequest(matcher), trigger(path)]);
      assert.equal(request.url(), origin + path); assert.equal(request.method(), 'GET');
      assert.equal(request, observed.find(value => value.url() === request.url()));
      assert.equal(request.frame(), page.mainFrame());
      outcomes[label] = { path, method: request.method(), identity: true, frame: true };
    }
    const occurrences = [];
    for (let index = 0; index < 2; index++) {
      const waiting = page.waitForRequest('/repeated');
      await trigger('/repeated'); occurrences.push(await waiting);
    }
    assert.notEqual(occurrences[0], occurrences[1]);
    assert.deepEqual(occurrences, observed.filter(request => request.url() === origin + '/repeated'));
    outcomes.repeatedURL = 'distinct original request occurrences';
    const redirectStart = page.waitForRequest('/redirect');
    const redirectEnd = page.waitForRequest('/redirected');
    await trigger('/redirect'); const from = await redirectStart; const to = await redirectEnd;
    assert.equal(to.redirectedFrom(), from); assert.equal(from.redirectedTo(), to);
    outcomes.redirects = ['/redirect', '/redirected'];
    const seen = [];
    const selected = page.waitForRequest(async request => { await Promise.resolve(); seen.push(new URL(request.url()).pathname); return request.url().endsWith('/chosen'); });
    await trigger('/ignored'); await trigger('/chosen'); assert.equal((await selected).url(), origin + '/chosen');
    assert.deepEqual(seen, ['/ignored', '/chosen']); outcomes.asyncFiltering = seen;
    const first = page.waitForRequest('/post'); const second = page.waitForRequest(request => request.method() === 'POST');
    await page.evaluate(() => fetch('/post', { method: 'POST', body: 'body-é', headers: { 'x-request-wait': 'present' } }).then(() => undefined));
    const request = await first; assert.equal(request, await second); assert.equal(request.postData(), 'body-é');
    assert.equal(request.headers()['x-request-wait'], 'present'); outcomes.post = { body: request.postData(), identity: true };

    const waiting = page.waitForRequest('/held'); const response = page.waitForResponse('/held');
    await page.evaluate(() => { void fetch('/held').then(() => undefined); });
    const early = await waiting; assert.equal(early.url(), origin + '/held');
    // Browser request observation can precede server acceptance; wait only for
    // that acceptance, with the response still deliberately held.
    const deadline = Date.now() + 4000;
    while (!held) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(held.writableEnded, false); held.end('released'); held = undefined;
    assert.equal((await response).request(), early); outcomes.beforeResponse = true;

    const sentinel = new Error('request predicate sentinel');
    const rejected = assert.rejects(page.waitForRequest(async request => { if (request.url().endsWith('/reject')) throw sentinel; return false; }), error => error === sentinel);
    await trigger('/reject'); await rejected; outcomes.callbackErrorIdentity = true;
    let release; let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const pending = assert.rejects(page.waitForRequest(() => { entered(); return new Promise(resolve => { release = resolve; }); }, { timeout: 500 }), timeout);
    await trigger('/pending'); await Promise.race([started, pending.then(() => { throw new Error('Request predicate was not entered before its deadline'); })]); await pending; release(true);
    await new Promise(resolve => setTimeout(resolve, 0)); outcomes.pendingPredicateDeadline = true;
    const defaultContextPage = await context.newPage(); context.setDefaultTimeout(30);
    await assert.rejects(defaultContextPage.waitForRequest('/never-context'), timeout);
    context.setDefaultTimeout(4000); page.setDefaultTimeout(30);
    await assert.rejects(page.waitForRequest('/never-page'), timeout);
    page.setDefaultTimeout(4000); await assert.rejects(page.waitForRequest('/never-explicit', { timeout: 30 }), timeout);
    outcomes.timeouts = ['context', 'page', 'explicit', 'pending predicate'];
    const baseline = page.listenerCount('request');
    const zero = page.waitForRequest('/zero', { timeout: 0 }); await trigger('/zero'); await zero;
    assert.equal(page.listenerCount('request'), baseline); outcomes.unlimitedAndListenerCleanup = true;

    if (name === 'flashwright') {
      for (const matcher of [undefined, null, 42, {}, new URL(origin)]) await assert.rejects(page.waitForRequest(matcher), error => error.name === 'InvalidArgumentError');
      if (typeof URLPattern === 'function') await assert.rejects(page.waitForRequest(new URLPattern({ pathname: '/x' })), error => error.name === 'InvalidArgumentError');
      for (const invalid of [-1, NaN, Infinity]) await assert.rejects(page.waitForRequest('/x', { timeout: invalid }), error => error.name === 'InvalidArgumentError');
      await assert.rejects(page.waitForRequest('/x', { unexpected: true }), error => error.name === 'UnsupportedFeatureError');
      assert.equal(page.listenerCount('request'), baseline);
      await context.tracing.start({ snapshots: false, screenshots: false, sources: false });
      const traced = page.waitForRequest('/traced'); await trigger('/traced'); await traced;
      await context.tracing.stop({ path: join(directory, 'flashwright-trace.zip') });
      report.candidateChecks = ['Malformed matchers/deadlines and unknown options reject without listener leaks', 'Canonical waitForRequest trace call completes independently of trigger'];
    }
    let releaseClosing; let enterClosing;
    const enteredClosing = new Promise(resolve => { enterClosing = resolve; });
    const closingPage = assert.rejects(page.waitForRequest(request => {
      if (!request.url().endsWith('/closing')) return false;
      enterClosing(); return new Promise(resolve => { releaseClosing = resolve; });
    }, { timeout: 4000 }), closed);
    await trigger('/closing');
    await Promise.race([enteredClosing, closingPage.then(() => { throw new Error('Predicate must start before closure'); })]);
    await page.close(); await closingPage; releaseClosing(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    outcomes.pendingPredicateClosure = true;
    const afterClose = await page.waitForRequest('/after-close', { timeout: 30 }).then(() => { throw new Error('Closed page wait unexpectedly resolved'); }, error => error);
    assert.equal(afterClose.name, name === 'playwright' ? 'TimeoutError' : 'TargetClosedError');
    (report.referenceDifferences ??= {})[name] = { alreadyClosedRequestWait: afterClose.name };
    const closingContext = assert.rejects(defaultContextPage.waitForRequest('/never-context-close', { timeout: 0 }), closed);
    await context.close(); await closingContext; outcomes.closure = ['page', 'context'];
  } finally { held?.end(); held = undefined; await browser.close(); }
}
try {
  await run('playwright', referenceChromium); await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.playwright);
  report.traceVerification = JSON.parse(execFileSync('python3', ['tools/verify-request-wait-traces.py', join(directory, 'flashwright-trace.zip')], { encoding: 'utf8' }));
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(driver)), report.driverSha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); throw error; }
finally { await fixture.close(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(directory); }
