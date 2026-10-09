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
  const matchingOrder = [];
  await context.route('**/old', async route => { matchingOrder.push('context-old'); await route.continue(); });
  await context.route('**/new', async route => { matchingOrder.push('context-new'); await route.continue(); });
  await page.route('**/old', async route => { matchingOrder.push('page-old'); await route.fallback(); });
  await page.route('**/new', async route => { matchingOrder.push('page-new'); await route.fallback(); });
  await page.route('**/old', async route => { matchingOrder.push('rewrite'); await route.fallback({ url: origin + '/new' }); });
  const redirectedByFallback = await page.evaluate(() => fetch('/old').then(response => response.json()));
  assert.equal(redirectedByFallback.url, '/new');
  report.cases.fallbackMatching = { order: matchingOrder, received: redirectedByFallback };
  await page.unrouteAll(); await context.unrouteAll();

  for (const behavior of ['default', 'ignoreErrors']) {
    const pathname = '/held-' + behavior;
    let enterHandler, releaseHandler, finishHandler;
    const entered = new Promise(resolve => { enterHandler = resolve; });
    const release = new Promise(resolve => { releaseHandler = resolve; });
    const finished = new Promise(resolve => { finishHandler = resolve; });
    let callback;
    await page.route('**' + pathname, async route => {
      enterHandler(); await release;
      try { await route.fulfill({ json: { originalCallback: true } }); callback = { status: 'fulfilled' }; }
      catch (error) { callback = { status: 'rejected', name: error.name, message: error.message }; }
      finally { finishHandler(); }
    });
    const fetching = page.evaluate(pathname => fetch(pathname).then(response => response.json()), pathname);
    await entered;
    await page.unrouteAll({ behavior });
    // Removal releases the original request independently of its still-held callback.
    const beforeRelease = { settled: true, value: await fetching };
    releaseHandler();
    const result = await fetching; await finished;
    const serverCount = requests.filter(request => request.url === pathname).length;
    assert.ok(serverCount <= 1, 'removal cannot replay original request');
    report.cases[behavior + 'Removal'] = { beforeRelease, result, callback, serverCount };
  }

  const closingPage = await context.newPage(); await closingPage.goto(origin);
  let enterClosing, releaseClosing, finishClosing;
  const enteredClosing = new Promise(resolve => { enterClosing = resolve; });
  const release = new Promise(resolve => { releaseClosing = resolve; });
  const finishedClosing = new Promise(resolve => { finishClosing = resolve; });
  let closingCallback;
  await closingPage.route('**/closing', async route => {
    enterClosing(); await release;
    try { await route.fulfill({ json: { tooLate: true } }); closingCallback = { status: 'fulfilled' }; }
    catch (error) { closingCallback = { status: 'rejected', name: error.name, message: error.message }; }
    finally { finishClosing(); }
  });
  const closingFetch = closingPage.evaluate(() => fetch('/closing').then(response => response.text())).then(value => ({ value }), error => ({ name: error.name, message: error.message }));
  await enteredClosing; await closingPage.close(); releaseClosing(); await finishedClosing;
  report.cases.closedCallback = { callback: closingCallback, evaluation: await closingFetch, serverCount: requests.filter(request => request.url === '/closing').length };
  // Chromium can release the original pause during target detachment, before this callback resumes.
  assert.ok(report.cases.closedCallback.serverCount <= 1, 'page closure and a late callback cannot replay the original request');
  await context.close();
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  await browser?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(join(directory, 'report.json'));
}
