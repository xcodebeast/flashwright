import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [engine, directory, mode = 'public'] = process.argv.slice(2);
assert(['reference', 'candidate'].includes(engine));
assert(['public', 'recording'].includes(mode));
assert(mode !== 'recording' || engine === 'candidate');
const { chromium } = await import(engine === 'reference' ? 'playwright' : 'flashwright');
const expected = new Map(), arrivals = [], events = [], bodies = [], checks = [];
const report = { status: 'running', engine, mode, checks, arrivals, events, scope: 'Renderer network lifecycle and original body ownership. Recording mode exercises private network resources only, not remote DOM snapshots or public trace archives.' };
let port, browser, context, recording;
const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  arrivals.push(url.href);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Date', 'Thu, 01 Jan 1970 00:00:00 GMT');
  response.setHeader('X-Original-Path', url.pathname);
  const send = (body, type = 'text/plain') => {
    expected.set(url.href, Buffer.from(body));
    response.setHeader('Content-Type', type); response.end(body);
  };
  if (url.pathname === '/root') send(`<link rel="icon" href="data:,"><iframe id="child" src="http://localhost:${port}/child?round=1"></iframe>`, 'text/html');
  else if (url.pathname === '/child') send(`<link rel="icon" href="data:,"><body data-round="${url.searchParams.get('round')}"><img src="/image"><link rel="stylesheet" href="/style"><iframe src="http://127.0.0.1:${port}/nested"></iframe><script>fetch('/redirect').then(r=>r.text()).then(x=>document.body.dataset.result=x);let xhr=new XMLHttpRequest();xhr.open('GET','/xhr');xhr.onload=()=>document.body.dataset.xhr=xhr.responseText;xhr.send();</script></body>`, 'text/html');
  else if (url.pathname === '/nested') send('<link rel="icon" href="data:,"><body data-ready="yes">nested document</body>', 'text/html');
  else if (url.pathname === '/redirect') { response.writeHead(302, { Location: '/data' }); response.end(); }
  else if (url.pathname === '/image') send('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', 'image/svg+xml');
  else if (url.pathname === '/style') send('body { color: rgb(10,20,30) }', 'text/css');
  else if (url.pathname === '/hanging') { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.write('original unfinished prefix'); }
  else send(url.pathname.slice(1) + ' bytes');
});
server.listen(0, '0.0.0.0'); await once(server, 'listening'); port = server.address().port;
const idle = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await idle(25); }
  throw new Error('fixture readiness exceeded five seconds');
}
const command = (suffix, extra = {}) => context.client.request(`context.trace.${suffix}`, { ...recording, ...extra }, 5000);
const resources = new Map();
async function drain() {
  for (let i = 0; i < 1000; i++) {
    const batch = await command('network.pull');
    for (const resource of batch.resources) {
      const bytes = await context.client.requestTraceAttachment('context.trace.network.take', { ...recording, token: resource.token }, 5000, resource.byteLength);
      assert.equal(bytes.length, resource.byteLength); assert(!resources.has(resource.token));
      resources.set(resource.token, bytes);
      await command('network.ingested', { token: resource.token });
    }
    if (!batch.pending && !batch.resources.length) return;
    await idle(5);
  }
  throw new Error('native resource drain did not settle');
}
try {
  browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  context = await browser.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  if (mode === 'recording') {
    recording = { context: context.identifier, recording: 'remote-network-fixture' };
    await command('recording.start', { network: true }); await command('chunk.start', { chunk: 'original' });
  }
  const requestIdentities = new Map();
  for (const kind of ['request', 'response', 'requestfinished', 'requestfailed']) page.on(kind, item => {
    const request = kind === 'response' ? item.request() : item;
    if (kind === 'request') { assert(!requestIdentities.has(request)); requestIdentities.set(request, requestIdentities.size); }
    assert(requestIdentities.has(request), 'lifecycle must retain the original public Request');
    events.push({ kind, identity: requestIdentities.get(request), url: item.url() });
    if (kind === 'response' && item.status() === 200) bodies.push((async () => {
      try {
        const [body, headers] = await Promise.all([item.body(), item.allHeaders()]);
        assert.equal(headers['x-original-path'], new URL(item.url()).pathname);
        assert.deepEqual(body, expected.get(item.url()));
        return { url: item.url(), byteLength: body.length };
      } catch (error) { return { url: item.url(), error: error.message }; }
    })());
  });
  await page.goto(`http://127.0.0.1:${port}/root`);
  for (let round = 1; round <= 3; round++) {
    if (round > 1) await page.evaluate(({ port, round }) => {
      document.querySelector('#child').src = `http://${round === 2 ? '127.0.0.1' : 'localhost'}:${port}/child?round=${round}`;
    }, { port, round });
    const child = page.frameLocator('#child');
    await until(async () => await child.locator('body').getAttribute('data-round') === String(round));
    await until(async () => await child.locator('body').getAttribute('data-result') === 'data bytes');
    await until(async () => await child.locator('body').getAttribute('data-xhr') === 'xhr bytes');
    await until(async () => await child.frameLocator('iframe').locator('body').getAttribute('data-ready') === 'yes');
    await Promise.all(bodies);
    if (mode === 'recording') await drain();
    checks.push(`round ${round}: document, nested frame, image, stylesheet, redirected fetch and XHR`);
  }
  const completed = await Promise.all(bodies);
  // Record the pinned reference's immediate body-read race on the departing renderer explicitly.
  const differences = completed.filter(item => item.error);
  if (engine === 'candidate') assert.deepEqual(differences, []);
  else for (const item of differences) {
    assert.equal(new URL(item.url).pathname + new URL(item.url).search, '/child?round=2');
    assert.match(item.error, /closed/);
  }
  report.referenceImmediateBodyDifferences = differences;
  await page.frameLocator('#child').locator('body').evaluate(() => { void fetch('/hanging'); });
  await until(() => events.some(event => event.kind === 'response' && event.url.endsWith('/hanging')));
  await page.evaluate(() => document.querySelector('#child').remove());
  report.bodyAfterChildRemoval = await Promise.race([Promise.all(bodies).then(() => 'settled'), idle(250).then(() => 'pending')]);
  if (engine === 'candidate') assert.equal(report.bodyAfterChildRemoval, 'settled');
  assert.equal(await page.evaluate(() => 42), 42);
  if (mode === 'recording') {
    await drain(); await command('chunk.seal', { chunk: 'original' });
    report.entries = [];
    for (let index = 0; index < 100; index++) {
      const entry = await command('network.entry', { chunk: 'original', index });
      if (entry.done) break;
      assert(entry.ready); report.entries.push(entry);
      const url = entry.metadata.request.url;
      if (url.endsWith('/redirect')) assert.equal(entry.body.reason, 'redirect');
      else if (url.endsWith('/hanging')) assert.equal(entry.body.reason, 'originalRendererClosed');
      else { assert.equal(entry.body.kind, 'resource'); assert.deepEqual(resources.get(entry.body.token), expected.get(url)); }
    }
    assert.equal(report.entries.length, events.filter(event => event.kind === 'request').length);
    checks.push('all recorded occurrences retain exact original body bytes or explicit redirect/renderer retirement outcomes');
    await command('recording.retire'); await command('recording.stop');
  }
  await page.close();
  report.bodies = await Promise.race([Promise.all(bodies), idle(1000).then(() => { throw new Error('bodies did not settle after page close'); })]);
  assert.equal(report.bodies.filter(item => item.url.endsWith('/hanging') && item.error).length, 1);
  checks.push('child removal settles original work, leaves parent healthy and cleans up');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, engine, mode, checks, error: report.error }));
}
