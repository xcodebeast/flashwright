import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { classifyPrivateStorageRequests, auditStorageRequests } from '../../tools/storage-request-observations.mjs';

const destination = `compatibility/evidence/storage-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const report = {
  reference: '1.60.0', ...runtimeMetadata, platform: process.platform, architecture: process.arch,
  sources: await sourceManifest(), browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()),
  driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), outcomes: {}, privateNetworkObservations: {}, lifetimeNetworkObservations: {}, serviceWorkerObservations: {}, candidateChecks: [], status: 'running',
  scope: 'Basic cookie and HTTP(S) localStorage state differential. IndexedDB and existing-context replacement remain unsupported. No performance claim.',
};
const requests = [];
let childOrigin;
const fixture = `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Storage</title><script>
window.startup = { local: localStorage.getItem('startup'), session: sessionStorage.getItem('session') };
</script>`;
const server = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url, cookie: request.headers.cookie ?? '', referer: request.headers.referer ?? '' });
  if (request.url === '/worker.js') {
    response.setHeader('content-type', 'application/javascript');
    response.end(`self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
      self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', event => {
        if (new URL(event.request.url).pathname === '/') event.respondWith(new Response('<script>localStorage.setItem("worker-ran", "unexpected application code")</script>', { headers: { 'content-type': 'text/html' } }));
      });`);
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (request.url === '/login') response.setHeader('set-cookie', 'session=logged-in; HttpOnly; SameSite=Lax; Path=/');
  if (request.url === '/authenticated') { response.end(fixture + `<output>${request.headers.cookie?.includes('session=logged-in') ? 'authenticated' : 'anonymous'}</output>`); return; }
  if (request.url === '/parent') { response.end(fixture + `<iframe name="child" src="${childOrigin}/child"></iframe>`); return; }
  response.end(fixture);
});
const childServer = createServer((request, response) => {
  requests.push({ child: true, method: request.method, path: request.url, referer: request.headers.referer ?? '' });
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(fixture + '<output></output><script>localStorage.setItem("child", "child origin"); document.querySelector("output").textContent = localStorage.getItem("child");</script>');
});
for (const instance of [server, childServer]) { instance.listen(0, '127.0.0.1'); await once(instance, 'listening'); }
const origin = 'http://127.0.0.1:' + server.address().port;
childOrigin = 'http://127.0.0.1:' + childServer.address().port;
const expiration = Math.floor(Date.now() / 1000) + 3600;
const cookieIdentity = cookie => JSON.stringify([cookie.domain, cookie.path, cookie.name, cookie.partitionKey ?? '', cookie._crHasCrossSiteAncestor ?? false]);
const sortCookies = cookies => [...cookies].sort((first, second) => cookieIdentity(first).localeCompare(cookieIdentity(second)));
const sortState = state => ({ cookies: sortCookies(state.cookies), origins: [...state.origins].sort((first, second) => first.origin.localeCompare(second.origin)).map(record => ({ ...record, localStorage: [...record.localStorage].sort((first, second) => first.name.localeCompare(second.name)) })) });
const entries = [
  { name: 'startup', value: 'restored before scripts' }, { name: '', value: '' }, { name: '__proto__', value: 'ordinary data' },
  { name: 'nul\0key', value: 'nul\0value' }, { name: 'astral 😀', value: '𝄞 and 日本語' },
  { name: 'high\uD800', value: 'low\uDFFF' }, { name: 'toString', value: 'not a method' },
];

async function run(name, chromium) {
  const lifetimeStart = requests.length;
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const result = report.outcomes[name] = {};
  const network = report.privateNetworkObservations[name] = [];
  const observePrivateNetwork = (phase, start, snapshots = 1) => {
    const received = requests.slice(start);
    const observation = { phase, maximumRequestsPerOrigin: snapshots, received };
    network.push(observation);
    observation.referenceFaviconRequests = classifyPrivateStorageRequests(name, received, { main: origin, child: childOrigin }, snapshots);
  };
  try {
    const context = await browser.newContext();
    const isolated = await browser.newContext();
    result.empty = await context.storageState();
    assert.deepEqual(result.empty, { cookies: [], origins: [] });
    const cookies = [
      { name: 'root', value: 'first', url: 'http://example.test/' },
      { name: 'directory', value: 'scoped', url: 'https://example.test/directory/page', httpOnly: true, sameSite: 'Strict', expires: expiration },
      { name: 'domain', value: 'subdomains', domain: '.example.test', path: '/', sameSite: 'Lax' },
      { name: 'secure', value: 'https', domain: 'example.test', path: '/', secure: true, sameSite: 'None' },
      { name: 'local', value: 'allowed', domain: '.localhost', path: '/', secure: true },
      { name: 'partitioned', value: 'partition A', domain: 'example.test', path: '/', secure: true, sameSite: 'None', partitionKey: 'https://top.test' },
      { name: 'partitioned', value: 'partition B', domain: 'example.test', path: '/', secure: true, sameSite: 'None', partitionKey: 'https://second.test' },
    ];
    await context.addCookies(cookies);
    await context.addCookies([{ name: 'root', value: 'replacement', url: 'http://example.test/' }]);
    result.cookies = sortCookies(await context.cookies());
    assert.equal(result.cookies.length, cookies.length);
    assert.equal(result.cookies.find(cookie => cookie.name === 'root').value, 'replacement');
    assert.deepEqual(await isolated.cookies(), []);
    const cookieRestored = await browser.newContext({ storageState: { cookies: result.cookies, origins: [] } });
    assert.deepEqual(sortCookies(await cookieRestored.cookies()), result.cookies, 'partitioned and ordinary cookies survive state restoration');
    assert.deepEqual(cookieRestored.pages(), []);
    await cookieRestored.close();
    result.urlFilters = {};
    for (const url of ['http://example.test/', 'https://example.test/directory/page', 'https://sub.example.test/', 'https://unrelated.test/', 'http://localhost/', 'http://child.localhost/', '']) result.urlFilters[url] = sortCookies(await context.cookies(url));
    result.multipleUrls = sortCookies(await context.cookies(['http://example.test/', 'https://example.test/directory/page']));
    const expression = /^(directory|partitioned)$/g;
    expression.lastIndex = 2;
    await context.clearCookies({ name: expression, domain: 'example.test', path: /^\/directory/ });
    assert.equal(expression.lastIndex, 2);
    result.filtered = sortCookies(await context.cookies());
    assert.equal(result.filtered.length, cookies.length - 1);
    await context.clearCookies({ name: 'partitioned' });
    result.partitionCleared = sortCookies(await context.cookies());
    assert.equal(result.partitionCleared.filter(cookie => cookie.name === 'partitioned').length, 0);
    await context.clearCookies({ name: 'not present' });
    assert.deepEqual(sortCookies(await context.cookies()), result.partitionCleared);
    await context.clearCookies({ name: '' });
    assert.deepEqual(await context.cookies(), []);
    await context.addCookies([{ name: 'expiry', value: 'present', url: origin, expires: expiration }]);
    await context.addCookies([{ name: 'expiry', value: 'gone', url: origin, expires: 0 }]);
    assert.deepEqual(await context.cookies(), []);
    result.cookiesPassed = true;
    console.log(`${name}: cookie attributes, URL filters, selective deletion, partitioning and isolation passed`);

    let pageEvents = 0;
    context.on('page', () => pageEvents++);
    const page = await context.newPage();
    await page.goto(origin + '/login');
    await page.evaluate(entries => {
      for (const { name, value } of entries) localStorage.setItem(name, value);
      sessionStorage.setItem('session', 'excluded');
    }, entries);
    await page.goto(origin + '/parent');
    assert.equal(await page.frame('child').locator('output').textContent(), 'child origin');
    await page.close();
    const eventCount = pageEvents;
    const requestCount = requests.length;
    const path = join(destination, name, 'nested', 'state.json');
    const state = await context.storageState({ path });
    result.state = sortState(state);
    for (let index = 0; index < 5; index++) {
      assert.deepEqual(sortState(await context.storageState()), result.state, 'repeated multi-origin collection must survive cancelled prior-document subresources');
    }
    observePrivateNetwork('closed-page-snapshots', requestCount, 6);
    assert.equal(pageEvents, eventCount, 'internal origin pages must remain private');
    assert.deepEqual(context.pages(), []);
    assert.deepEqual(sortState(JSON.parse(await readFile(path, 'utf8'))), result.state);
    assert.deepEqual(result.state.origins.find(record => record.origin === origin).localStorage, sortState({ cookies: [], origins: [{ origin, localStorage: entries }] }).origins[0].localStorage);
    assert.equal(result.state.origins.length, 2, 'closed pages and child origins must remain tracked');
    assert.deepEqual(await isolated.storageState(), { cookies: [], origins: [] });
    for (const storageState of [state, path]) {
      const beforeRestore = requests.length;
      const restored = await browser.newContext({ storageState });
      observePrivateNetwork(typeof storageState === 'string' ? 'restore-file' : 'restore-object', beforeRestore);
      assert.deepEqual(restored.pages(), []);
      const beforeExport = requests.length;
      assert.deepEqual(sortState(await restored.storageState()), result.state, 'state is immediately exportable before any public page');
      observePrivateNetwork(typeof storageState === 'string' ? 'reexport-file' : 'reexport-object', beforeExport);
      const restoredPage = await restored.newPage();
      await restoredPage.goto(origin + '/authenticated');
      assert.deepEqual(await restoredPage.evaluate(() => startup), { local: 'restored before scripts', session: null });
      assert.equal(await restoredPage.locator('output').textContent(), 'authenticated');
      const restoredEntries = await restoredPage.evaluate(entries => entries.map(({ name }) => ({ name, value: localStorage.getItem(name) })), entries);
      assert.deepEqual(restoredEntries, entries);
      await restored.close();
    }
    const emptyOrigin = await isolated.newPage();
    await emptyOrigin.goto(origin);
    await emptyOrigin.close();
    assert.deepEqual(await isolated.storageState(), { cookies: [], origins: [] });
    result.statePassed = true;
    const secureState = { cookies: [], origins: [{ origin: 'https://storage.example.test', localStorage: [{ name: 'secure origin', value: 'restored privately' }] }] };
    const secureContext = await browser.newContext({ storageState: secureState });
    assert.deepEqual(await secureContext.storageState(), secureState);
    await secureContext.close();
    console.log(`${name}: exact UTF-16, closed-page/child origins, private collection, backend login and object/file restoration passed`);

    if (name === 'flashwright') {
      const invalid = (code) => error => error.name === code;
      await assert.rejects(context.addCookies([{ name: 'partial', value: 'must not appear', url: origin }, { name: 'bad', value: 'bad' }]), invalid('InvalidArgumentError'));
      assert.equal((await context.cookies()).some(cookie => cookie.name === 'partial'), false);
      await assert.rejects(context.addCookies([{ name: 'native-partial', value: 'must not appear', url: origin }, { name: 'native-invalid', value: 'invalid\nvalue', url: origin }]));
      assert.equal((await context.cookies()).some(cookie => cookie.name === 'native-partial'), false, 'Chromium must reject the invalid batch before applying valid entries');
      for (const storageState of [{ origins: [{ origin, localStorage: [], indexedDB: [] }] }, { origins: [{ origin: 'file:///tmp', localStorage: [] }] }, { origins: 'bad' }]) {
        const before = browser.contexts().length;
        await assert.rejects(browser.newContext({ storageState }));
        assert.equal(browser.contexts().length, before, 'invalid state cannot publish a context');
      }
      await assert.rejects(context.storageState({ indexedDB: true }), invalid('UnsupportedFeatureError'));
      await assert.rejects(context.setStorageState(state), invalid('UnsupportedFeatureError'));
      const largePage = await context.newPage();
      await largePage.goto(origin);
      await largePage.evaluate(() => localStorage.setItem('too-large', 'x'.repeat(100001)));
      const beforeLimit = requests.length;
      await assert.rejects(context.storageState({ path }), invalid('ResourceLimitError'));
      assert.equal(requests.length, beforeLimit);
      assert.deepEqual(sortState(JSON.parse(await readFile(path, 'utf8'))), result.state, 'failed collection must preserve the prior complete file');
      assert.deepEqual(context.pages(), [largePage]);
      await largePage.evaluate(() => localStorage.removeItem('too-large'));
      assert.deepEqual(sortState(await context.storageState()), result.state);
      await largePage.close();
      const beforeFailure = browser.contexts().length;
      await assert.rejects(browser.newContext({ storageState: { cookies: [{ name: 'rejected', value: 'invalid\nvalue', domain: '127.0.0.1', path: '/' }], origins: [] } }), error => error.details.cleanup === 'resourceDisposed');
      assert.equal(browser.contexts().length, beforeFailure);
      const recovered = await browser.newContext();
      assert.deepEqual(await recovered.storageState(), { cookies: [], origins: [] });
      await recovered.close();
      report.candidateChecks.push('batch validation before mutation', 'invalid/unsupported state before allocation', 'snapshot resource limit and prior-file preservation', 'recovery after resource failure', 'failed restoration publishes no context');
    }
    const workerContext = await browser.newContext();
    const workerPage = await workerContext.newPage();
    await workerPage.goto(origin + '/login');
    await workerPage.evaluate(async () => {
      localStorage.setItem('before', 'original');
      await navigator.serviceWorker.register('/worker.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    await workerPage.close();
    const workerState = await workerContext.storageState();
    const workerRan = workerState.origins[0].localStorage.some(entry => entry.name === 'worker-ran');
    report.serviceWorkerObservations[name] = { state: sortState(workerState), applicationCodeRanDuringSnapshot: workerRan };
    assert.equal(workerRan, name === 'reference', 'candidate intentionally avoids the reference internal-page service-worker side effect');
    if (name === 'flashwright') assert.deepEqual(workerState.origins[0].localStorage, [{ name: 'before', value: 'original' }]);
    await workerContext.close();
    await context.close();
    await isolated.close();
  } finally {
    try { await browser.close(); }
    finally { report.lifetimeNetworkObservations[name] = { received: requests.slice(lifetimeStart) }; }
  }
  const audit = report.lifetimeNetworkObservations[name];
  // Six closed-page collections, two restores and two re-exports visit both
  // origins; the empty-origin and worker collections can visit the main origin.
  audit.maximumPrivateNavigations = { main: 12, child: 10 };
  audit.expectedPublicRequests = ['main GET /login', 'main GET /parent', 'child GET /child',
    'main GET /authenticated', 'main GET /authenticated', 'main GET /',
    ...(name === 'flashwright' ? ['main GET /'] : []), 'main GET /login', 'main GET /worker.js'];
  audit.referenceFaviconRequests = auditStorageRequests(name, audit.received,
    { main: origin, child: childOrigin }, audit.expectedPublicRequests, audit.maximumPrivateNavigations);
  audit.status = 'passed';
}

try {
  await run('reference', referenceChromium);
  await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.reference);
  report.sourceChangedDuringVerification = JSON.stringify(report.sources) !== JSON.stringify(await sourceManifest());
  assert.equal(report.sourceChangedDuringVerification, false);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  for (const instance of [server, childServer]) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); }
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Storage differential ${report.status}: ${destination}/report.json`);
  if (report.error) console.error(report.error.stack);
}
