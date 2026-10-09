import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';

const sockets = new Set();
const requestObservers = new Map();
const largeBinary = Buffer.alloc(9 * 1024 * 1024);
for (let index = 0; index < largeBinary.length; index++) largeBinary[index] = index % 256;
const largeBodies = new Map([['/large-binary', largeBinary], ['/escaped-text', Buffer.alloc(2 * 1024 * 1024)]]);
const bodyRequests = new Map();
function nextRequest(path) { return new Promise(resolve => requestObservers.set(path, resolve)); }
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture');
  requestObservers.get(url.pathname)?.();
  requestObservers.delete(url.pathname);
  if (url.pathname === '/post-body') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    bodyRequests.set(request.url, (bodyRequests.get(request.url) ?? 0) + 1);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ bytes: [...Buffer.concat(chunks)] }));
    return;
  }
  if (largeBodies.has(url.pathname)) {
    bodyRequests.set(url.pathname, (bodyRequests.get(url.pathname) ?? 0) + 1);
    response.setHeader('content-type', url.pathname === '/escaped-text' ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    response.end(largeBodies.get(url.pathname));
    return;
  }
  if (url.pathname === '/redirect') { response.writeHead(302, { location: '/final' }); response.end(); return; }
  if (url.pathname === '/json') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ answer: 42, unicode: 'é😃' })); return; }
  if (url.pathname === '/binary') { response.end(Buffer.from([0, 128, 255, 1])); return; }
  if (url.pathname === '/stall' || url.pathname === '/stall-resource') { return; }
  if (url.pathname === '/superseded') { response.setHeader('content-type', 'text/html'); response.end('<img src="/stall-resource">'); return; }
  if (url.pathname === '/slow-image') { setTimeout(() => { response.writeHead(404); response.end(); }, 200); return; }
  if (url.pathname === '/slow-child') { setTimeout(() => { response.end('<title>Child</title>child'); }, 150); return; }
  if (url.pathname === '/referer') { response.end(request.headers.referer ?? 'missing'); return; }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.pathname === '/missing') response.statusCode = 404;
  if (url.pathname === '/lifecycle') response.end('<title>Lifecycle</title><img src="/slow-image"><iframe src="/slow-child"></iframe>');
  else response.end('<title>Navigation fixture</title><h1>' + url.pathname + '</h1>');
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseURL = 'http://127.0.0.1:' + server.address().port;
const outcomes = {};

async function run(name, chromium) {
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath() });
  const context = await browser.newContext({ baseURL });
  context.setDefaultTimeout(3000);
  const page = await context.newPage();
  const result = {};
  try {
    const events = [];
    page.on('request', request => events.push(['request', new URL(request.url()).pathname]));
    page.on('response', response => events.push(['response', response.status(), new URL(response.url()).pathname]));
    const response = await page.goto('/redirect');
    assert.equal(page.url(), baseURL + '/final');
    assert.equal(await page.title(), 'Navigation fixture');
    assert.equal(response.url(), page.url());
    assert.equal(response.status(), 200);
    assert.equal(response.request().isNavigationRequest(), true);
    assert.equal(response.request().resourceType(), 'document');
    assert.match(await response.text(), /<h1>\/final<\/h1>/);
    result.redirect = { url: new URL(response.url()).pathname, status: response.status(), requests: events.filter(event => event[0] === 'request'), responses: events.filter(event => event[0] === 'response') };

    const sameDocument = await page.goto('/final#section');
    assert.equal(sameDocument, null);
    assert.equal(page.url(), baseURL + '/final#section');
    result.sameDocument = page.url().endsWith('#section');

    const navigationWait = page.waitForURL('**/final#next');
    await page.evaluate(() => { location.hash = 'next'; });
    await navigationWait;
    result.urlWait = true;
    const predicateWait = page.waitForURL(url => url.pathname === '/other', { waitUntil: 'commit' });
    await page.goto('/other', { waitUntil: 'commit' });
    await predicateWait;

    const observedResponse = page.waitForResponse(async response => response.url().endsWith('/json') && (await response.headerValue('content-type')).includes('json'));
    await page.evaluate(async () => { await fetch('/json'); });
    const jsonResponse = await observedResponse;
    result.json = await jsonResponse.json();
    assert.deepEqual(result.json, { answer: 42, unicode: 'é😃' });
    const binaryResponse = page.waitForResponse('**/binary');
    await page.evaluate(async () => { await fetch('/binary'); });
    assert.deepEqual(await (await binaryResponse).body(), Buffer.from([0, 128, 255, 1]));
    result.requestBodies = [];
    for (const [label, bytes] of [
      ['binary', [...Buffer.from(Array.from({ length: 256 }, (_, index) => index))]],
      ['utf8', [...Buffer.from('é😃\0body')]],
      ['empty', []],
    ]) {
      const path = '/post-body?case=' + label;
      const count = bodyRequests.get(path) ?? 0;
      const observedRequest = page.waitForEvent('request', { predicate: request => request.url().endsWith(path) });
      const observedResponse = page.waitForResponse(response => response.url().endsWith(path));
      await page.evaluate(async ({ path, bytes }) => { await (await fetch(path, { method: 'POST', body: new Uint8Array(bytes) })).arrayBuffer(); }, { path, bytes });
      const request = await observedRequest;
      const response = await observedResponse;
      assert.equal(response.request(), request);
      assert.deepEqual(request.postDataBuffer(), bytes.length ? Buffer.from(bytes) : null);
      assert.equal(request.postData(), bytes.length ? Buffer.from(bytes).toString('utf8') : null);
      assert.deepEqual(await response.json(), { bytes });
      assert.equal(bodyRequests.get(path) - count, 1);
      result.requestBodies.push({ label, bytes: [...(request.postDataBuffer() ?? [])], text: request.postData(), requests: 1 });
    }
    result.largeBodies = [];
    for (const [path, expected] of largeBodies) {
      const count = bodyRequests.get(path) ?? 0;
      const observed = page.waitForResponse('**' + path);
      await page.evaluate(async path => { await (await fetch(path)).arrayBuffer(); }, path);
      const received = await (await observed).body();
      assert.deepEqual(received, expected);
      assert.equal(bodyRequests.get(path) - count, 1);
      result.largeBodies.push({ path, bytes: received.length, sha256: createHash('sha256').update(received).digest('hex'), requests: 1 });
    }

    const missing = await page.goto('/missing');
    result.httpFailure = { status: missing.status(), ok: missing.ok() };
    assert.deepEqual(result.httpFailure, { status: 404, ok: false });
    const referer = await page.goto('/referer', { referer: baseURL + '/custom' });
    assert.equal(await referer.text(), baseURL + '/custom');

    await page.goto('/lifecycle', { waitUntil: 'domcontentloaded' });
    assert.equal(page.frames().length, 2);
    assert.equal(page.mainFrame().childFrames().length, 1);
    await page.waitForLoadState('load');
    assert.equal(await page.evaluate(() => document.readyState), 'complete');
    await page.waitForLoadState('networkidle');
    result.lifecycle = { frames: page.frames().length, ready: await page.evaluate(() => document.readyState) };

    await assert.rejects(page.goto('/stall', { timeout: 100 }), error => error.name === 'TimeoutError');
    await page.goto('/recovered');
    result.timeoutRecovery = new URL(page.url()).pathname;
    const requested = nextRequest('/stall');
    const superseded = page.goto('/stall').then(() => null, error => error);
    await requested;
    await page.goto('/winner');
    const interruption = await superseded;
    assert(interruption instanceof Error);
    assert.match(interruption.message, /interrupted|ERR_ABORTED/i);
    result.supersession = { rejected: true, url: new URL(page.url()).pathname };

    for (const [path, matcher] of [
      ['/group/path?x=1', '**/{path,other}?x=1'],
      ['/query?foo=bar', '/query?foo=*'],
      ['/unicode/%E2%9C%93', '/unicode/**'],
    ]) {
      await page.goto(path);
      await page.waitForURL(matcher);
    }
    result.globs = true;
    await page.goto('/hash#same');
    assert.equal(await page.goto('/hash#same'), null);
    assert.equal(await page.goto('about:blank'), null);
    await page.waitForLoadState();
    result.blank = page.url();
    await page.goto('/final');
    const sentinel = new Error('response predicate failure');
    const rejectedPredicate = assert.rejects(page.waitForResponse(() => { throw sentinel; }), error => error === sentinel);
    await page.evaluate(async () => { await fetch('/json'); });
    await rejectedPredicate;
    result.predicateFailure = true;

    let observedRequest;
    const requestObserver = request => { if (request.url().endsWith('/json')) observedRequest = request; };
    page.on('request', requestObserver);
    const requestResponse = page.waitForResponse('**/json');
    await page.evaluate(async () => { await fetch('/json'); });
    assert.equal(await observedRequest.response(), await requestResponse);
    page.off('request', requestObserver);
    result.requestResponseIdentity = true;

    const closeWait = page.waitForEvent('close');
    const waitingResponse = page.waitForResponse('**/never').then(() => 'unexpected success', error => error.message);
    await page.close();
    await closeWait;
    assert.match(await waitingResponse, /closed/i);
    result.closed = page.isClosed();
    return result;
  } finally { await browser.close(); }
}

try {
  outcomes.reference = await run('reference', referenceChromium);
  outcomes.flashwright = await run('flashwright', flashwrightChromium);
  await mkdir('compatibility/evidence', { recursive: true });
  const evidence = { fixture: 'compatibility/m2/navigation.mjs', fixtureSha256: createHash('sha256').update(await readFile('compatibility/m2/navigation.mjs')).digest('hex'), reference: '1.60.0', ...runtimeMetadata, platform: process.platform, architecture: process.arch, outcomes };
  const destination = 'compatibility/evidence/navigation-' + process.platform + '-' + process.arch + '-' + runtimeArtifactLabel + '.json';
  await writeFile(destination, JSON.stringify(evidence, null, 2) + '\n');
  assert.deepEqual(outcomes.flashwright, outcomes.reference);
  console.log('Navigation differential passed: ' + destination);
} finally {
  for (const socket of sockets) socket.destroy();
  server.close();
}
