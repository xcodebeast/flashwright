import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const implementation = process.env.FLASHWRIGHT_ROUTING_IMPLEMENTATION ?? 'flashwright';
assert.ok(['playwright', 'flashwright'].includes(implementation));
const { chromium } = await import(implementation);
import { identifyBrowser } from '../../tools/browser-identity.mjs';
const directory = resolve(process.argv[2]);
await mkdir(directory);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const record = { url: request.url, method: request.method, headers: request.headers, body: [...Buffer.concat(chunks)] };
  requests.push(record);
  if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Route contract</title>'); }
  else if (request.url === '/redirect') { response.writeHead(302, { Location: '/echo-redirect' }); response.end(); }
  else { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(record)); }
});
const report = { status: 'running', referenceVersion: '1.60.0', implementation, probeSha256: hash(await readFile(new URL(import.meta.url))), requests, cases: {} };
let browser;
try {
  assert.equal(JSON.parse(await readFile('node_modules/playwright/package.json')).version, '1.60.0');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const context = await browser.newContext({ baseURL: origin });
  const page = await context.newPage();
  await page.goto(origin);
  const order = [];
  const seen = [];
  const contextHandler = async (route, request) => { order.push('context'); seen.push(request); await route.continue(); };
  const olderHandler = async (route, request) => { order.push('page-older'); seen.push(request); await route.fallback({ headers: { ...request.headers(), 'x-fallback': 'kept' } }); };
  const contextRegistration = await context.route('**/echo-chain', contextHandler);
  const pageRegistration = await page.route('**/echo-chain', olderHandler);
  await page.route('**/echo-chain', async route => { order.push('page-once'); await route.fulfill({ json: { intercepted: true } }); }, { times: 1 });
  const first = await page.evaluate(() => fetch('/echo-chain').then(response => response.json()));
  const second = await page.evaluate(() => fetch('/echo-chain').then(response => response.json()));
  assert.deepEqual(first, { intercepted: true });
  assert.deepEqual(order, ['page-once', 'page-older', 'context']);
  assert.equal(seen[0], seen[1]);
  assert.equal(second.headers['x-fallback'], 'kept');
  report.cases.precedence = { order, sameRequest: seen[0] === seen[1], first, second, disposers: [typeof contextRegistration.dispose, typeof pageRegistration.dispose] };
  await pageRegistration.dispose(); await contextRegistration.dispose();

  let continuedRequest;
  await page.route('**/echo-override', async (route, request) => {
    continuedRequest = request;
    await route.continue({ url: origin + '/echo-new-url', method: 'POST', headers: { ...request.headers(), 'content-type': 'application/octet-stream', 'x-route': 'original' }, postData: Buffer.from([0, 255, 128, 13]) });
  });
  const overridden = await page.evaluate(() => fetch('/echo-override').then(response => response.json()));
  assert.deepEqual(overridden.body, [0, 255, 128, 13]);
  assert.equal(overridden.method, 'POST'); assert.equal(overridden.url, '/echo-new-url');
  report.cases.continue = { received: overridden, publicUrl: continuedRequest.url(), publicMethod: continuedRequest.method(), publicBody: continuedRequest.postDataBuffer() ? [...continuedRequest.postDataBuffer()] : null };
  await page.unrouteAll();

  let fulfilledRoute;
  await page.route('**/bytes', async route => { fulfilledRoute = route; await route.fulfill({ status: 201, contentType: 'application/octet-stream', headers: { 'x-route': 'bytes' }, body: Buffer.from([0, 255, 128, 13]) }); });
  const fulfilled = await page.evaluate(async () => { const response = await fetch('/bytes'); return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())], type: response.headers.get('content-type'), length: response.headers.get('content-length') }; });
  assert.deepEqual(fulfilled.bytes, [0, 255, 128, 13]); assert.equal(fulfilled.status, 201); assert.equal(fulfilled.length, '4');
  await assert.rejects(fulfilledRoute.abort(), /already handled/i);
  report.cases.fulfill = fulfilled;
  await page.unrouteAll();

  const redirectCalls = [];
  await page.route('**/*redirect*', async (route, request) => { redirectCalls.push(new URL(request.url()).pathname); await route.continue({ headers: { ...request.headers(), 'x-redirect': 'retained' } }); });
  const redirected = await page.evaluate(() => fetch('/redirect').then(response => response.json()));
  assert.deepEqual(redirectCalls, ['/redirect']); assert.equal(redirected.headers['x-redirect'], 'retained');
  report.cases.redirect = { calls: redirectCalls, received: redirected };
  await page.unrouteAll();

  const aborted = page.waitForEvent('requestfailed', request => request.url().endsWith('/abort'));
  await page.route('**/abort', route => route.abort('blockedbyclient'));
  const fetchFailure = await page.evaluate(() => fetch('/abort').then(() => 'unexpected-success', error => error.name));
  const failedRequest = await aborted;
  assert.equal(fetchFailure, 'TypeError');
  report.cases.abort = { fetchFailure, failure: failedRequest.failure(), response: await failedRequest.response() };
  await page.unrouteAll();

  let enterHandler;
  const entered = new Promise(resolve => { enterHandler = resolve; });
  let releaseHandler;
  const released = new Promise(resolve => { releaseHandler = resolve; });
  await page.route('**/held', async route => { enterHandler(); await released; await route.continue(); });
  const heldFetch = page.evaluate(() => fetch('/held').then(response => response.json()));
  await entered;
  let unrouteFinished = false;
  const unroute = page.unrouteAll({ behavior: 'wait' }).then(() => { unrouteFinished = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(unrouteFinished, false);
  releaseHandler(); await unroute; const held = await heldFetch;
  report.cases.waitRemoval = { waitedForHandler: true, received: held };

  const corsCalls = [];
  await page.route('**/cors', async (route, request) => { corsCalls.push(request.method()); await route.fulfill({ json: { crossOrigin: true } }); });
  const crossOrigin = await page.evaluate(async url => fetch(url, { method: 'POST', headers: { 'x-custom': 'preflight' }, body: 'payload' }).then(response => response.json()), `http://localhost:${server.address().port}/cors`);
  assert.deepEqual(crossOrigin, { crossOrigin: true }); assert.deepEqual(corsCalls, ['POST']);
  report.cases.cors = { calls: corsCalls, body: crossOrigin };
  await context.close();
  assert.equal(requests.filter(request => request.url === '/echo-chain').length, 1);
  assert.equal(requests.filter(request => ['/bytes', '/abort', '/cors'].includes(request.url)).length, 0);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  await browser?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(join(directory, 'report.json'));
}
