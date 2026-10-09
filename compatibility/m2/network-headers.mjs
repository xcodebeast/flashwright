import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';
import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';

const sockets = new Set();
const heldResponses = new Map();
const counts = new Map();
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  counts.set(request.url, (counts.get(request.url) ?? 0) + 1);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Date', 'Thu, 01 Jan 1970 00:00:00 GMT');
  if (url.pathname === '/failed') { request.socket.destroy(); return; }
  if (url.pathname === '/held') {
    response.writeHead(200, { 'Content-Type': 'text/plain', 'X-Held': 'original' });
    response.write('first'); heldResponses.set(url.searchParams.get('consumer'), response); return;
  }
  if (url.pathname === '/resource') { response.end('resource'); return; }
  if (url.pathname === '/image') { response.setHeader('Content-Type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'); return; }
  if (url.pathname === '/fanout') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html>' + Array.from({ length: 1030 }, (_, index) => `<img src="/image?consumer=${url.searchParams.get('consumer')}&index=${index}">`).join(''));
    return;
  }
  if (url.pathname === '/cache') { response.setHeader('Cache-Control', 'public, max-age=3600'); response.setHeader('X-Cached', 'same'); response.end('cache'); return; }
  if (url.pathname.startsWith('/redirect')) {
    const hop = Number(url.pathname.slice('/redirect'.length));
    response.writeHead(302, ['Location', hop === 1 ? '/redirect2' : '/headers', 'X-Hop', String(hop), 'Set-Cookie', `hop${hop}=value${hop}; Path=/`]);
    response.end(); return;
  }
  if (url.pathname === '/headers') {
    response.writeHead(200, ['Content-Type', 'text/html', 'X-Mixed', 'first', 'x-mixed', 'second', 'X-Empty', '', 'Set-Cookie', 'first=one; Path=/', 'Set-Cookie', 'second=two; Path=/']);
    response.end('<!doctype html><title>Headers</title>headers'); return;
  }
  response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Fixture</title>fixture');
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const outcomes = {};

async function run(consumer, chromium) {
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath() });
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  const page = await context.newPage();
  const result = {};
  try {
    const redirectResponses = [];
    const observer = response => { if (new URL(response.url()).pathname.startsWith('/redirect')) redirectResponses.push(response); };
    page.on('response', observer);
    const response = await page.goto(origin + '/redirect1');
    page.off('response', observer);
    result.redirectHeaders = [];
    for (const redirect of redirectResponses) {
      result.redirectHeaders.push({ hop: await redirect.headerValue('x-hop'), cookies: await redirect.headerValues('SET-cookie'), cookieSent: (await redirect.request().headerValue('cookie')) ?? null });
      assert.equal(await redirect.request().response(), redirect);
    }
    assert.deepEqual(result.redirectHeaders.map(entry => entry.hop), ['1', '2']);
    assert.equal(result.redirectHeaders[1].cookieSent, 'hop1=value1');
    result.raw = (await response.headersArray()).filter(header => ['x-mixed', 'x-empty', 'set-cookie'].includes(header.name.toLowerCase()));
    result.values = await response.headerValues('x-mixed');
    result.mixed = await response.headerValue('X-MIXED');
    result.cookies = await response.headerValues('set-cookie');
    result.cookieJoined = await response.headerValue('set-cookie');
    result.empty = await response.headerValue('x-empty');
    result.absent = await response.headerValue('not-a-header');
    result.prototypeName = await response.headerValue('__proto__');
    assert.deepEqual(result.values, ['first', 'second']);
    assert.equal(result.mixed, 'first, second');
    assert.equal(result.cookieJoined, 'first=one; Path=/\nsecond=two; Path=/');
    assert.equal(result.empty, '');
    assert.equal(result.absent, null);
    assert.equal(result.prototypeName, null);
    const mutated = await response.headersArray(); mutated.push({ name: 'bad', value: 'mutated' });
    assert.ok((await response.headersArray()).every(header => header.value !== 'mutated'));
    const originalEntryValue = mutated[0].value;
    mutated[0].value = 'mutated entry';
    assert.equal((await response.headersArray())[0].value, 'mutated entry');
    assert.equal(await response.headerValue(mutated[0].name), originalEntryValue);
    mutated[0].value = originalEntryValue;
    const all = await response.allHeaders(); all['x-mixed'] = 'mutated';
    assert.equal((await response.allHeaders())['x-mixed'], 'first, second');
    result.copyIsolation = true;

    let earlyHeaders;
    const requestObserver = request => { if (request.url().endsWith('/resource?headers')) earlyHeaders = request.allHeaders(); };
    page.on('request', requestObserver);
    const received = page.waitForResponse('**/resource?headers');
    await page.evaluate(async () => { await (await fetch('/resource?headers', { headers: { 'X-Client': 'custom' } })).text(); });
    const request = (await received).request();
    const requestHeaders = await earlyHeaders;
    assert.equal(requestHeaders['x-client'], 'custom');
    assert.match(requestHeaders.cookie, /first=one/);
    const requestArray = await request.headersArray();
    assert.ok(requestArray.some(header => header.name.toLowerCase() === 'cookie' && header.value.includes('second=two')));
    assert.equal(await request.headerValue('not-a-header'), null);
    requestArray.push({ name: 'X-Array-Mutation', value: 'visible only in array' });
    assert.equal((await request.headersArray()).at(-1).name, 'X-Array-Mutation');
    assert.equal(await request.headerValue('x-array-mutation'), null);
    requestArray.pop();
    result.requestHeaders = { custom: requestHeaders['x-client'], cookies: requestHeaders.cookie.split('; ').sort(), provisionalCookie: request.headers().cookie ?? null };
    page.off('request', requestObserver);

    result.cache = [];
    for (let index = 0; index < 2; index++) {
      const received = page.waitForResponse('**/cache');
      await page.evaluate(async () => { await (await fetch('/cache')).text(); });
      const cached = await received;
      result.cache.push({ header: await cached.headerValue('x-cached'), requestHeader: typeof (await cached.request().allHeaders()).accept });
    }
    const failedRequest = page.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/failed') });
    const failedStarted = page.waitForEvent('request', { predicate: request => request.url().endsWith('/failed') });
    await page.evaluate(async () => { await fetch('/failed').catch(() => {}); });
    const failed = await failedRequest;
    assert.equal(failed, await failedStarted);
    assert.equal(await failed.response(), null);
    assert.ok(await failed.allHeaders());
    result.failedHeadersResolved = true;

    const heldPath = '/held?consumer=' + consumer;
    const heldRequestEvent = page.waitForEvent('request', { predicate: request => request.url().endsWith(heldPath) });
    const heldResponseEvent = page.waitForResponse('**' + heldPath);
    await page.evaluate(path => { globalThis.heldBody = fetch(path).then(response => response.text()); }, heldPath);
    const heldRequest = await heldRequestEvent;
    const heldResponse = await heldResponseEvent;
    await page.evaluate(async consumer => {
      for (let start = 0; start < 1030; start += 32) {
        await Promise.all(Array.from({ length: Math.min(32, 1030 - start) }, async (_, offset) => {
          await (await fetch('/resource?consumer=' + consumer + '&index=' + (start + offset))).text();
        }));
      }
    }, consumer);
    const heldFinishedEvent = page.waitForEvent('requestfinished', { predicate: request => request.url().endsWith(heldPath) });
    heldResponses.get(consumer).end('last');
    assert.equal(await page.evaluate(() => globalThis.heldBody), 'firstlast');
    assert.equal(await heldFinishedEvent, heldRequest);
    assert.equal(heldResponse.request(), heldRequest);
    assert.equal(await heldRequest.response(), heldResponse);
    assert.equal(await heldResponse.text(), 'firstlast');
    assert.equal(counts.get(heldPath), 1);
    result.activeIdentitySurvivesHistory = true;

    let navigationResponse;
    const navigationObserver = response => { if (new URL(response.url()).pathname === '/fanout') navigationResponse = response; };
    page.on('response', navigationObserver);
    const fanout = await page.goto(origin + '/fanout?consumer=' + consumer, { timeout: 30000 });
    page.off('response', navigationObserver);
    assert.equal(fanout, navigationResponse);
    assert.equal(fanout.status(), 200);
    assert.equal(await fanout.request().response(), fanout);
    assert.match(await fanout.text(), /index=1029/);
    result.navigationSurvivesHistory = true;
    await page.close();
    assert.equal(await response.headerValue('x-mixed'), 'first, second');
    result.cachedHeadersAfterClose = true;
    return result;
  } finally { await browser.close(); }
}

try {
  outcomes.reference = await run('reference', referenceChromium);
  outcomes.flashwright = await run('flashwright', flashwrightChromium);
  assert.deepEqual(outcomes.flashwright, outcomes.reference);
  const destination = `compatibility/evidence/network-headers-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}.json`;
  await mkdir('compatibility/evidence', { recursive: true });
  await writeFile(destination, JSON.stringify({ fixture: 'compatibility/m2/network-headers.mjs', fixtureSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), reference: '1.60.0', ...runtimeMetadata, platform: process.platform, architecture: process.arch, outcomes }, null, 2) + '\n');
  console.log('Network headers differential passed: ' + destination);
} finally { for (const socket of sockets) socket.destroy(); server.close(); }
