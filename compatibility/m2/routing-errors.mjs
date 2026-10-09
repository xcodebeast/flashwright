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
  if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Route failures</title>'); }
  else { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(record)); }
});
const report = { status: 'running', referenceVersion: '1.60.0', implementation, probeSha256: hash(await readFile(new URL(import.meta.url))), requests, cases: {} };
let browser;
const unhandled = [];
const collectUnhandled = error => { unhandled.push({ name: error.name, message: error.message, stack: error.stack }); };
process.on('unhandledRejection', collectUnhandled);

/** Poll only the probe's asynchronous error delivery, under a fixed diagnostic bound. */
async function waitForUnhandled(message) {
  const deadline = performance.now() + 2000;
  while (!unhandled.some(error => error.message.includes(message))) {
    assert.ok(performance.now() < deadline, 'route callback error was not delivered');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

try {
  assert.equal(JSON.parse(await readFile('node_modules/playwright/package.json')).version, '1.60.0');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  browser = await chromium.launch({ executablePath: report.browser.executablePath });

  for (const behavior of ['throw-before', 'reject-after-await', 'throw-after-continue', 'throw-after-fallback']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    const pathname = '/' + behavior;
    const marker = 'original user callback: ' + behavior;
    let lowerHandlerCalls = 0;
    await page.route('**' + pathname, async route => { lowerHandlerCalls++; await route.continue(); });
    await page.route('**' + pathname, async route => {
      if (behavior === 'reject-after-await') await Promise.resolve();
      if (behavior === 'throw-after-continue') await route.continue();
      if (behavior === 'throw-after-fallback') await route.fallback();
      throw new Error(marker);
    });
    const fetching = page.evaluate(pathname => fetch(pathname).then(response => response.json()), pathname);
    await waitForUnhandled(marker);
    const beforeRemoval = await Promise.race([
      fetching.then(value => ({ settled: true, value })),
      new Promise(resolve => setTimeout(() => resolve({ settled: false }), 75)),
    ]);
    const serverCountBefore = requests.filter(request => request.url === pathname).length;
    await page.unrouteAll();
    const result = await fetching;
    const callbackError = unhandled.find(error => error.message.includes(marker));
    assert.ok(callbackError.stack.includes('routing-errors.mjs'), 'original callback location remains visible');
    assert.equal(requests.filter(request => request.url === pathname).length, 1, 'cleanup cannot replay a request');
    report.cases[behavior] = { beforeRemoval, serverCountBefore, lowerHandlerCalls, result, callbackError };
    await context.close();
  }

  const context = await browser.newContext();
  await context.addCookies([{ name: 'session', value: 'original-cookie', url: origin }]);
  const page = await context.newPage();
  await page.goto(origin);
  // Optional raw CDP diagnostics are outside this public Route corpus.
  const rawRequests = null;
  let observed;
  await page.route('**/binary-original', async (route, request) => {
    observed = { originalBytes: [...request.postDataBuffer()], originalText: request.postData(), originalHeaders: await request.allHeaders() };
    await route.continue({ url: origin + '/binary-effective', method: 'PUT', headers: { ...request.headers(), Cookie: 'session=ignored-override', 'X-Routed': 'yes' }, postData: Buffer.from([255, 0, 128, 13]) });
    observed.effective = { url: request.url(), method: request.method(), bytes: [...request.postDataBuffer()], headers: await request.allHeaders() };
  });
  const binaryResult = await page.evaluate(() => fetch('/binary-original', { method: 'POST', body: new Uint8Array([0, 255, 128, 10]) }).then(response => response.json()));
  assert.deepEqual(observed.originalBytes, [0, 255, 128, 10]);
  assert.deepEqual(binaryResult.body, [255, 0, 128, 13]);
  assert.equal(binaryResult.method, 'PUT');
  assert.equal(binaryResult.headers.cookie, 'session=original-cookie');
  report.cases.binaryCookieOverrides = { observed, result: binaryResult, rawRequests };
  await page.unrouteAll();
  let duplicateCalls = 0;
  const duplicateHandler = async route => { duplicateCalls++; await route.continue(); };
  const disposer = await page.route('**/duplicate', duplicateHandler);
  await page.route('**/duplicate', duplicateHandler);
  await disposer.dispose();
  await page.evaluate(() => fetch('/duplicate').then(response => response.text()));
  report.cases.duplicateDisposer = { duplicateCalls };
  assert.equal(duplicateCalls, 0);
  await context.close();
  assert.equal(unhandled.length, 4);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  process.removeListener('unhandledRejection', collectUnhandled);
  report.unhandled = unhandled;
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(join(directory, 'report.json'));
}
