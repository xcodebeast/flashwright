import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { identifyBrowser } from '../../tools/browser-identity.mjs';

const implementation = process.env.FLASHWRIGHT_ROUTING_IMPLEMENTATION ?? 'flashwright';
assert.ok(['playwright', 'flashwright'].includes(implementation));
const { chromium } = await import(implementation);
const directory = resolve(process.argv[2]); await mkdir(directory);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function deferred() { let resolve; const promise = new Promise(settle => { resolve = settle; }); return { promise, resolve }; }
const requests = [];
const server = createServer(async (request, response) => {
  let bytes = 0; const digest = createHash('sha256');
  for await (const chunk of request) { bytes += chunk.length; digest.update(chunk); }
  const record = { url: request.url, method: request.method, bytes, sha256: digest.digest('hex') };
  requests.push(record);
  if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Routing payloads</title>'); }
  else { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(record)); }
});
const report = { status: 'running', referenceVersion: '1.60.0', implementation, probeSha256: hash(await readFile(new URL(import.meta.url))), cases: {} };
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const context = await browser.newContext(); const page = await context.newPage(); await page.goto(origin);
  for (const operation of ['continue', 'fulfill']) {
    for (const size of [0, 65537, 4 * 1024 * 1024, 32 * 1024 * 1024]) {
      const bytes = Buffer.alloc(size);
      for (let index = 0; index < size; index++) bytes[index] = index % 256;
      const expected = { bytes: size, sha256: hash(bytes) };
      const pathname = `/${operation}-${size}`;
      let metadata;
      await page.route('**' + pathname, async (route, request) => {
        if (operation === 'continue') {
          await route.continue({ method: 'POST', postData: bytes });
          metadata = { method: request.method(), bytes: request.postDataBuffer().length, sha256: hash(request.postDataBuffer()) };
        } else await route.fulfill({ contentType: 'application/octet-stream', body: bytes });
      });
      const result = await page.evaluate(async ({ pathname, operation }) => {
        const response = await fetch(pathname);
        if (operation === 'continue') return response.json();
        const body = await response.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', body);
        return { bytes: body.byteLength, sha256: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('') };
      }, { pathname, operation });
      await page.unrouteAll({ behavior: 'wait' });
      assert.deepEqual({ bytes: result.bytes, sha256: result.sha256 }, expected);
      if (operation === 'continue') {
        assert.equal(result.method, 'POST');
        assert.deepEqual(metadata, { method: 'POST', ...expected });
      }
      const serverCount = requests.filter(request => request.url === pathname).length;
      assert.equal(serverCount, operation === 'continue' ? 1 : 0);
      report.cases[`${operation}-${size}`] = { ...expected, serverCount };
    }
  }
  for (const status of [200, 204, 300, 301, 304, 306, 399, 400, 500, 599]) {
    const pathname = `/status-${status}`, bytes = Buffer.from([0, 1, 127, 128, 255, 13, 10]);
    await page.route('**' + pathname, route => route.fulfill({ status, contentType: 'application/octet-stream', body: bytes }));
    const [response, fetched] = await Promise.all([
      page.waitForResponse('**' + pathname),
      page.evaluate(async pathname => { const response = await fetch(pathname); return { status: response.status, statusText: response.statusText, bytes: [...new Uint8Array(await response.arrayBuffer())] }; }, pathname),
    ]);
    assert.deepEqual(fetched, { status, statusText: response.statusText(), bytes: [...bytes] });
    if (status === 399 || status === 599) assert.equal(response.statusText(), 'Unknown');
    if (status === 306) assert.equal(response.statusText(), 'Switch Proxy');
    let publicBody;
    if (status >= 300 && status < 400) {
      await assert.rejects(response.body(), error => {
        assert.equal(error.name, 'Error');
        assert.match(error.message, /Response body is unavailable for redirect responses$/);
        publicBody = { error: error.name, reason: 'Response body is unavailable for redirect responses' };
        return true;
      });
    } else {
      const body = await response.body(); assert.deepEqual(body, bytes);
      publicBody = { bytes: body.length, sha256: hash(body) };
    }
    const serverCount = requests.filter(request => request.url === pathname).length;
    assert.equal(serverCount, 0);
    report.cases[`response-status-${status}`] = { status: response.status(), fetched, publicBody, serverCount };
    await page.unrouteAll({ behavior: 'wait' });
  }
  const bodyPath = join(directory, 'response.json'); await writeFile(bodyPath, '{"fromFile":"exact"}');
  await page.route('**/file', route => route.fulfill({ path: bodyPath, headers: { 'Set-Cookie': 'first=one; Path=/\nsecond=two; Path=/', 'X-File': 'yes' } }));
  report.cases.file = await page.evaluate(async () => {
    const response = await fetch('/file');
    return { body: await response.json(), contentType: response.headers.get('content-type'), custom: response.headers.get('x-file'), cookies: document.cookie.split('; ').sort() };
  });
  assert.deepEqual(report.cases.file, { body: { fromFile: 'exact' }, contentType: 'application/json', custom: 'yes', cookies: ['first=one', 'second=two'] });
  await page.unrouteAll();
  for (const value of [false, 0, null, { valid: true }]) {
    await page.route('**/json', route => route.fulfill({ json: value }));
    const result = await page.evaluate(async () => { const response = await fetch('/json'); return { value: await response.json(), contentType: response.headers.get('content-type') }; });
    assert.deepEqual(result.value, value); report.cases['json-' + JSON.stringify(value)] = result;
    await page.unrouteAll();
  }
  const entered = deferred(), release = deferred();
  await page.route('**/unrelated', route => route.abort());
  await page.route('**/held', async route => { entered.resolve(); await release.promise; await route.fulfill({ body: 'kept paused' }); });
  const fetching = page.evaluate(() => fetch('/held').then(response => response.text()));
  await entered.promise; await page.unroute('**/unrelated');
  const beforeRelease = await Promise.race([fetching.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('pending'), 60))]);
  release.resolve(); const body = await fetching;
  assert.equal(beforeRelease, 'pending'); assert.equal(body, 'kept paused');
  report.cases.unrelatedRemoval = { beforeRelease, body, serverCount: requests.filter(request => request.url === '/held').length };
  assert.equal(report.cases.unrelatedRemoval.serverCount, 0); await page.unrouteAll();
  const cancelledEntered = deferred(), cancelledRelease = deferred(), cancelledDone = deferred();
  let lateResult;
  await page.route('**/cancelled', async route => {
    cancelledEntered.resolve(); await cancelledRelease.promise;
    try { await route.fulfill({ body: 'too late' }); lateResult = 'resolved'; }
    catch (error) { lateResult = error.name; }
    finally { cancelledDone.resolve(); }
  });
  const failed = page.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/cancelled') });
  const cancelledFetch = page.evaluate(() => { window.controller = new AbortController(); return fetch('/cancelled', { signal: window.controller.signal }).then(() => 'fulfilled', error => error.name); });
  await cancelledEntered.promise; await page.evaluate(() => window.controller.abort()); await failed;
  cancelledRelease.resolve(); await cancelledDone.promise;
  report.cases.cancelledRequest = { evaluation: await cancelledFetch, lateResult, serverCount: requests.filter(request => request.url === '/cancelled').length };
  assert.deepEqual(report.cases.cancelledRequest, { evaluation: 'AbortError', lateResult: 'resolved', serverCount: 0 });
  const childRequestEvent = page.waitForEvent('request', { predicate: request => request.url().endsWith('/child-frame') });
  await page.evaluate(() => new Promise(resolve => {
    const child = document.createElement('iframe'); child.src = '/child-frame'; child.onload = () => resolve(true); document.body.append(child);
  }));
  const childRequest = await childRequestEvent, originalFrame = childRequest.frame();
  assert.equal(originalFrame.parentFrame(), page.mainFrame());
  const detached = page.waitForEvent('framedetached', { predicate: frame => frame === originalFrame });
  await page.evaluate(() => document.querySelector('iframe').remove()); await detached;
  assert.equal(originalFrame.isDetached(), true); assert.equal(childRequest.frame(), originalFrame);
  await page.close(); assert.equal(childRequest.frame(), originalFrame);
  report.cases.requestFrameLifetime = { detached: true, originalFramePreserved: true, preservedAfterPageClose: true };
  await context.close(); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(join(directory, 'report.json'));
}
