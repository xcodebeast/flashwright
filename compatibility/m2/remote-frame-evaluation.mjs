import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as candidateChromium } from 'flashwright';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { runtimeMetadata } from '../../tools/javascript-runtime.mjs';
import { sourceManifest } from '../../tools/source-manifest.mjs';

const destination = resolve(process.argv[2] ?? '.cache/remote-frame-evaluation');
await mkdir(destination, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath();
const driverPath = process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver');
const report = {
  schemaVersion: 1, status: 'running', reference: '1.60.0', ...runtimeMetadata,
  platform: process.platform, architecture: process.arch, outcomes: {}, candidateBoundaries: [],
  scope: 'Application worker and audio worklet liveness, sandboxed SVG previews, cross-site Frame and handle evaluation, lazy FrameLocator element resolution, nested renderer documents, interrupted callbacks without replay, renderer return, and context closure. Candidate-only checks reject unsupported remote init scripts, routing, and storage collection in either configuration order. Remote input, network delivery, diagnostics, performance, and release acceptance are outside this fixture.',
};

let port;
const workerStarts = [];
const boundaryStarts = new Set();
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  const path = request.url.split('?')[0];
  if (path === '/worker.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end('fetch("/worker-start?kind=url");postMessage("url");const nested=new Worker("/nested-worker.js");nested.onmessage=event=>postMessage(event.data)');
  } else if (path === '/nested-worker.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end('fetch("/worker-start?kind=nested");postMessage("nested")');
  } else if (path === '/audio-worklet.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end('class FixtureProcessor extends AudioWorkletProcessor { constructor() { super(); this.port.postMessage("started"); } process(inputs, outputs) { for (const channel of outputs[0]) channel.fill(0.25); return false; } } registerProcessor("fixture", FixtureProcessor)');
  } else if (path === '/worker-start') {
    workerStarts.push(new URL(request.url, 'http://fixture').searchParams.get('kind'));
    response.end('ok');
  } else if (path === '/boundary-start') {
    boundaryStarts.add(new URL(request.url, 'http://fixture').searchParams.get('token'));
    response.end('ok');
  } else if (path === '/boundary-parent') {
    const token = new URL(request.url, 'http://fixture').searchParams.get('token');
    response.end(`<iframe src="http://localhost:${port}/boundary-child?token=${encodeURIComponent(token)}"></iframe>`);
  } else if (path === '/boundary-child') {
    const token = new URL(request.url, 'http://fixture').searchParams.get('token');
    response.end(`<script>fetch('/boundary-start?token='+${JSON.stringify(token)})</script><body>boundary</body>`);
  } else if (path === '/parent') {
    response.end(`<script>window.received=[];addEventListener('message',event=>received.push(event.data));addEventListener('load',()=>window.rootLoaded=true)</script><iframe id="child" src="http://localhost:${port}/child"></iframe>`);
  } else if (path === '/child') {
    response.end(`<body>Child<script>addEventListener('message',event=>parent.postMessage(event.data,'*'));parent.postMessage('child','*')</script><iframe id="local" src="/local"></iframe><iframe id="remote" src="http://127.0.0.1:${port}/remote"></iframe></body>`);
  } else {
    response.end(`<body>${path}<script>parent.postMessage(${JSON.stringify(path.slice(1))},'*')</script></body>`);
  }
});
server.listen(0);
await once(server, 'listening');
port = server.address().port;

/** Exercise the same application and semantic checks through each public implementation. */
async function run(engine, chromium) {
  const browser = await chromium.launch({ executablePath: browserPath });
  const observations = [];
  workerStarts.length = 0;
  report.outcomes[engine] = observations;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/parent`, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.rootLoaded), true);
    const messages = await page.evaluate(() => window.received.slice().sort());
    assert.deepEqual(messages, ['child', 'local', 'remote']);
    observations.push({ case: 'nested remote and same-process application scripts complete load', messages });
    await page.evaluate(origin => {
      window.workerMessages = [];
      window.workerErrors = [];
      const code = `fetch(${JSON.stringify(origin + '/worker-start?kind=blob')});postMessage("blob")`;
      window.fixtureWorkers = [new Worker('/worker.js'), new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })))];
      for (const worker of fixtureWorkers) {
        worker.onmessage = event => workerMessages.push(event.data);
        worker.onerror = event => workerErrors.push(event.message);
      }
    }, `http://127.0.0.1:${port}`);
    const workerDeadline = Date.now() + 5000;
    while ((await page.evaluate(() => workerMessages.length)) < 3 || workerStarts.length < 3) {
      assert.ok(Date.now() < workerDeadline, 'ordinary URL, blob, and nested workers must continue executing');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(await page.evaluate(() => workerMessages.slice().sort()), ['blob', 'nested', 'url']);
    assert.deepEqual(await page.evaluate(() => workerErrors), []);
    assert.deepEqual(workerStarts.slice().sort(), ['blob', 'nested', 'url']);
    observations.push({ case: 'URL, blob, and nested application workers execute without public worker APIs' });
    const audio = await page.evaluate(async () => {
      const context = new OfflineAudioContext(1, 128, 44100);
      await context.audioWorklet.addModule('/audio-worklet.js');
      const node = new AudioWorkletNode(context, 'fixture');
      const started = new Promise(resolve => { node.port.onmessage = event => resolve(event.data); });
      node.connect(context.destination);
      const buffer = await context.startRendering();
      return { signal: await started, sample: buffer.getChannelData(0)[0] };
    });
    assert.deepEqual(audio, { signal: 'started', sample: 0.25 });
    observations.push({ case: 'audio worklet module and processor execute normally' });
    await page.evaluate(() => {
      window.svgLoads = 0;
      const preview = document.createElement('iframe');
      preview.id = 'sandbox';
      preview.setAttribute('sandbox', 'allow-scripts');
      preview.onload = () => svgLoads++;
      preview.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="20" height="20"/></svg>');
      document.body.append(preview);
    });
    const previewDeadline = Date.now() + 5000;
    while ((await page.evaluate(() => svgLoads)) === 0) {
      assert.ok(Date.now() < previewDeadline, 'sandboxed SVG preview must finish loading');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const svg = await page.frameLocator('#sandbox').locator('svg').evaluate(element => element.outerHTML, undefined, { timeout: 5000 });
    assert.match(svg, /<svg.*<rect.*<\/svg>/);
    await page.evaluate(() => document.querySelector('#sandbox').remove());
    observations.push({ case: 'sandboxed data SVG loads and resolves through FrameLocator' });
    const remoteLocator = page.frameLocator('#child').locator('body');
    const originalFrame = page.frames().find(frame => frame.url() === `http://localhost:${port}/child`);
    assert.ok(originalFrame);
    assert.equal(await originalFrame.evaluate(() => location.hostname), 'localhost');
    assert.ok((await remoteLocator.evaluate(element => element.textContent)).startsWith('Child'));
    assert.equal(await page.frameLocator('#child').frameLocator('#local').locator('body').evaluate(element => element.firstChild.textContent), '/local');
    assert.equal(await page.frameLocator('#child').frameLocator('#remote').locator('body').evaluate(element => element.firstChild.textContent), '/remote');
    const originalElement = await remoteLocator.elementHandle();
    assert.ok(originalElement);
    assert.equal(await originalElement.evaluate(element => element.ownerDocument.defaultView.location.hostname), 'localhost');
    const object = await originalFrame.evaluateHandle(() => ({ nested: { value: 31 } }));
    assert.equal(await object.evaluate(value => value.nested.value), 31);
    await object.dispose();
    if (engine === 'flashwright') {
      await assert.rejects(remoteLocator.fill('unadmitted'), /out-of-process/);
      report.candidateBoundaries.push('Remote locator fill remains explicitly unsupported');
    }
    observations.push({ case: 'Frame evaluation, handles, and nested remote/same-process lazy locator evaluation' });
    const pending = originalElement.evaluate(element => {
      parent.postMessage('callback-entered', '*');
      return new Promise(() => {});
    }).then(() => { throw new Error('old document callback must fail after navigation'); }, error => {
      assert.match(error.message, /context|closed|destroyed|detached/i);
    });
    const callbackDeadline = Date.now() + 5000;
    while (!(await page.evaluate(() => received.includes('callback-entered')))) {
      assert.ok(Date.now() < callbackDeadline, 'captured callback must enter before navigation');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await page.evaluate(url => { document.querySelector('#child').src = url; }, `http://127.0.0.1:${port}/local`);
    const deadline = Date.now() + 5000;
    while (!(await page.evaluate(() => window.received.filter(value => value === 'local').length >= 2))) {
      assert.ok(Date.now() < deadline, 'returning child must continue executing');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await pending;
    await assert.rejects(originalElement.evaluate(element => element.textContent), /context|closed|destroyed|owned|disposed/i);
    assert.equal(await originalFrame.evaluate(() => location.pathname), '/local');
    assert.equal(await remoteLocator.evaluate(element => element.firstChild.textContent), '/local');
    assert.equal(await page.evaluate(() => received.filter(value => value === 'callback-entered').length), 1);
    await originalElement.dispose();
    observations.push({ case: 'original handle and pending callback retire without replay; lazy locator and Frame follow renderer return' });
    await page.evaluate(() => document.querySelector('#child').remove());
    assert.equal(await page.evaluate(() => document.querySelectorAll('iframe').length), 0);
    observations.push({ case: 'remote child returns to parent renderer and detaches' });
    await context.close();
    for (let index = 0; index < 3; index++) {
      const closingContext = await browser.newContext();
      const closingPage = await closingContext.newPage();
      await closingPage.goto(`http://127.0.0.1:${port}/local`);
      await closingPage.evaluate(url => { const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame); }, `http://localhost:${port}/child`);
      await closingContext.close();
    }
    observations.push({ case: 'parent closure during child attachment', iterations: 3 });
    if (engine === 'flashwright') await verifyCandidateBoundaries(browser);
  } finally { await browser.close(); }
}

/** Unsupported remote configuration must be explicit in either registration order. */
async function verifyCandidateBoundaries(browser) {
  const unsupported = error => error.name === 'UnsupportedFeatureError' && /out-of-process/.test(error.message);
  for (const scope of ['page', 'context']) {
    for (const feature of ['scripts', 'routes']) {
      for (const configureFirst of [true, false]) {
        const token = `${scope}-${feature}-${configureFirst}`;
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          const owner = scope === 'page' ? page : context;
          const configure = () => feature === 'scripts'
            ? owner.addInitScript(() => { window.boundaryInitScript = true; })
            : owner.route('**/never-matches-this-fixture', route => route.continue());
          const navigate = () => page.goto(`http://127.0.0.1:${port}/boundary-parent?token=${token}`, { timeout: 5000 });
          if (configureFirst) {
            await configure();
            await assert.rejects(navigate(), unsupported);
          } else {
            await navigate();
            await assert.rejects(configure(), unsupported);
            assert.equal(await page.evaluate(() => document.querySelectorAll('iframe').length), 1);
            // Rejected registration must not affect a later remote attachment.
            if (scope === 'context') {
              const followingPage = await context.newPage();
              await followingPage.goto(`http://127.0.0.1:${port}/boundary-parent?token=${token}-following`, { timeout: 5000 });
              await followingPage.close();
            } else {
              await page.evaluate(url => {
                const child = document.createElement('iframe');
                child.src = url;
                document.body.append(child);
              }, `http://localhost:${port}/boundary-child?token=${token}-following`);
              const followingDeadline = Date.now() + 5000;
              while (!boundaryStarts.has(`${token}-following`)) {
                assert.ok(Date.now() < followingDeadline, 'rejected page registration must not poison later attachment');
                await new Promise(resolve => setTimeout(resolve, 20));
              }
              assert.equal(await page.evaluate(() => document.querySelectorAll('iframe').length), 2);
            }
          }
          const deadline = Date.now() + 5000;
          while (!boundaryStarts.has(token)) {
            assert.ok(Date.now() < deadline, `rejected configuration must release the original child: ${token}`);
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          await assert.rejects(context.storageState(), unsupported);
          await page.close();
          await assert.rejects(context.storageState(), unsupported);
          report.candidateBoundaries.push(`${scope} ${feature}: ${configureFirst ? 'configuration before attachment' : 'attachment before configuration'} rejects explicitly, child executes, storage limitation persists`);
        } finally { await context.close(); }
      }
    }
  }
}

try {
  report.fixtureSha256 = hash(await readFile(new URL(import.meta.url)));
  report.sources = await sourceManifest();
  report.driverSha256 = hash(await readFile(driverPath));
  report.browser = await identifyBrowser(browserPath);
  const reference = JSON.parse(await readFile(new URL('../reference-manifest.json', import.meta.url), 'utf8')).reference;
  assert.equal(report.browser.version, reference.chromiumVersion, 'Use the pinned Chromium version');
  assert.equal(report.browser.distribution, 'full-chromium', 'This remote-frame fixture requires pinned full Chromium; stock headless shell keeps these cross-site children in the parent renderer');
  await run('reference', referenceChromium);
  await run('flashwright', candidateChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.reference);
  assert.equal(report.outcomes.flashwright.length, 8);
  assert.equal(report.candidateBoundaries.length, 9);
  report.sourceChangedDuringVerification = JSON.stringify(await sourceManifest()) !== JSON.stringify(report.sources);
  report.driverChangedDuringVerification = hash(await readFile(driverPath)) !== report.driverSha256;
  report.browserChangedDuringVerification = hash(await readFile(browserPath)) !== report.browser.sha256;
  assert.equal(report.sourceChangedDuringVerification, false);
  assert.equal(report.driverChangedDuringVerification, false);
  assert.equal(report.browserChangedDuringVerification, false);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, destination }));
}
