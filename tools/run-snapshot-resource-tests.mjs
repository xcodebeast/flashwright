import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve('package.json'));
const { identifyBrowser } = await import(pathToFileURL(resolve('tools/browser-identity.mjs')));
const { iso, utils, server: traceServer } = require('playwright-core/lib/coreBundle');
const reference = require('playwright');
const implementation = process.argv.includes('--candidate') ? 'flashwright' : process.env.FLASHWRIGHT_RESOURCE_IMPLEMENTATION ?? 'playwright';
assert.ok(['playwright', 'flashwright'].includes(implementation));
const candidate = require(implementation);
const output = resolve(process.argv[2]);
await mkdir(output);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {
  status: 'running', implementation,
  scope: 'Public manual snapshots: parent and child frames load the same resource URL but retain distinct CSSOM overrides and frame-specific HAR references. Original HTTP server stops before pinned viewer replay.',
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH),
  toolSha256: hash(await readFile(new URL(import.meta.url))),
  pinnedDistributionSha256: hash(await readFile('node_modules/playwright-core/lib/coreBundle.js')),
  cases: [], requests: [],
};
let origin;
let browser;
let viewerBrowser;
let viewer;
let originalServerStopped = false;
const application = createServer((request, response) => {
  report.requests.push(request.url);
  response.setHeader('cache-control', 'no-store');
  if (request.url === '/style.css') {
    response.setHeader('content-type', 'text/css');
    response.end('#external { color: rgb(20, 40, 60); }');
  } else if (request.url === '/pixel.svg') {
    response.setHeader('content-type', 'image/svg+xml');
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><path fill="red" d="M0 0h2v3H0z"/></svg>');
  } else if (request.url === '/favicon.ico') { response.statusCode = 204; response.end(); }
  else {
    response.setHeader('content-type', 'text/html');
    const child = request.url === '/child';
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"><style>#inline {color:rgb(11,22,33)}</style></head><body><span id="external">external</span><span id="inline">inline</span><img id="image" src="/pixel.svg"><button id="checkpoint" onclick="this.textContent=\'recorded\'">checkpoint</button>' + (child ? '' : '<iframe id="child" src="/child"></iframe>') + '</body></html>');
  }
});
function pageState() {
  const read = document => {
    const image = document.querySelector('#image');
    return {
      externalColor: document.defaultView.getComputedStyle(document.querySelector('#external')).color,
      inlineColor: document.defaultView.getComputedStyle(document.querySelector('#inline')).color,
      imageWidth: image.naturalWidth, imageHeight: image.naturalHeight,
      button: document.querySelector('#checkpoint').textContent,
    };
  };
  return { parent: read(document), child: read(document.querySelector('#child').contentDocument) };
}
async function startRecording(tracing, screenshots) {
  const options = { snapshots: true, screenshots, sources: false };
  await tracing.start(options);
}
async function inspectArchive(item) {
  const archive = new utils.ZipFile(item.path);
  try {
    const names = await archive.entries();
    const loader = new iso.TraceLoader();
    await loader.load({ entryNames: async () => names, readText: async name => names.includes(name) ? (await archive.read(name)).toString() : undefined, hasEntry: async name => names.includes(name), isLive: () => false });
    assert.equal(loader.contextEntries.length, 1);
    const actions = loader.contextEntries[0].actions;
    const action = actions.findLast(action => action.method === 'click');
    assert.ok(action?.afterSnapshot, 'checkpoint click must have an after snapshot');
    const events = (await archive.read('trace.trace')).toString().trim().split('\n').filter(Boolean).map(JSON.parse);
    const snapshot = events.find(event => event.type === 'frame-snapshot' && event.snapshot.snapshotName === action.afterSnapshot && event.snapshot.isMainFrame)?.snapshot;
    assert.ok(snapshot);
    const network = (await archive.read('trace.network')).toString().trim().split('\n').filter(Boolean).map(JSON.parse);
    const resources = network.filter(event => event.type === 'resource-snapshot').map(event => event.snapshot);
    const stylesheet = resources.filter(resource => resource.request.url === `${origin}/style.css`);
    const image = resources.filter(resource => resource.request.url === `${origin}/pixel.svg`);
    assert.equal(stylesheet.length > 0, item.timing === 'during');
    assert.equal(image.length > 0, item.timing === 'during');
    const selectedSnapshots = events.filter(event => event.type === 'frame-snapshot' && event.snapshot.snapshotName === action.afterSnapshot).map(event => event.snapshot);
    assert.equal(selectedSnapshots.length, 2, 'parent and child each own an after snapshot');
    assert.equal(new Set(selectedSnapshots.map(snapshot => snapshot.frameId)).size, 2);
    item.archive = { sha256: hash(await readFile(item.path)), entries: names, action, selectedSnapshots, network, stylesheetResources: stylesheet.length, imageResources: image.length, frameOverrides: [] };
    for (const selectedSnapshot of selectedSnapshots) {
      const frameSnapshots = events.filter(event => event.type === 'frame-snapshot' && event.snapshot.frameId === selectedSnapshot.frameId).map(event => event.snapshot);
      const snapshotIndex = frameSnapshots.indexOf(selectedSnapshot);
      let override = selectedSnapshot.resourceOverrides.find(resource => resource.url === `${origin}/style.css`);
      if (override?.ref) {
        const originalIndex = snapshotIndex - override.ref;
        assert.ok(originalIndex >= 0 && originalIndex < snapshotIndex);
        override = frameSnapshots[originalIndex].resourceOverrides.find(resource => resource.url === `${origin}/style.css`);
      }
      if (item.timing === 'during') {
        const ownedStylesheets = stylesheet.filter(resource => resource._frameref === selectedSnapshot.frameId);
        const ownedImages = image.filter(resource => resource._frameref === selectedSnapshot.frameId);
        assert.ok(ownedStylesheets.length > 0, 'each frame has an original stylesheet network entry');
        assert.ok(ownedImages.length > 0, 'each frame has an original image network entry');
        assert.ok(override?.sha1, 'each mutated sheet owns a frame-specific override');
        const content = (await archive.read(`resources/${override.sha1}`)).toString();
        assert.ok(content.includes(selectedSnapshot.isMainFrame ? 'rgb(60, 80, 100)' : 'rgb(100, 120, 140)'));
        for (const resource of ownedStylesheets) assert.notEqual(override.sha1, resource.response.content._sha1, 'CSSOM override is distinct from original network body');
        item.archive.frameOverrides.push({ frameId: selectedSnapshot.frameId, isMainFrame: selectedSnapshot.isMainFrame, sha1: override.sha1, content });
      }
    }
    if (item.timing === 'during') assert.notEqual(item.archive.frameOverrides[0].sha1, item.archive.frameOverrides[1].sha1, 'same URL cannot collapse two frame-local CSSOM bodies');
  } finally { archive.close(); }
}
try {
  await new Promise(resolve => application.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${application.address().port}`;
  report.origin = origin;
  browser = await candidate.chromium.launch({ executablePath: report.browser.executablePath });
  for (const timing of ['before', 'during']) for (const screenshots of [false, true]) {
    const item = { timing, screenshots, path: join(output, `${timing}-${screenshots}.zip`) };
    report.cases.push(item);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      if (timing === 'during') await startRecording(context.tracing, screenshots);
      await page.goto(origin);
      const initial = { externalColor: 'rgb(20, 40, 60)', inlineColor: 'rgb(11, 22, 33)', imageWidth: 2, imageHeight: 3, button: 'checkpoint' };
      assert.deepEqual(await page.evaluate(pageState), { parent: initial, child: initial });
      if (timing === 'before') await startRecording(context.tracing, screenshots);
      await page.evaluate(() => {
        document.styleSheets[0].cssRules[0].style.color = 'rgb(60, 80, 100)';
        document.querySelector('#child').contentDocument.styleSheets[0].cssRules[0].style.color = 'rgb(100, 120, 140)';
      });
      await page.locator('#checkpoint').click();
      item.liveState = await page.evaluate(pageState);
      assert.equal(item.liveState.parent.externalColor, 'rgb(60, 80, 100)');
      assert.equal(item.liveState.child.externalColor, 'rgb(100, 120, 140)');
      await context.tracing.stop({ path: item.path });
      await inspectArchive(item);
    } finally { await context.close(); }
  }
  await browser.close(); browser = undefined;
  await new Promise((resolve, reject) => application.close(error => error ? reject(error) : resolve()));
  originalServerStopped = true;
  report.originalServerStoppedBeforeReplay = true;
  viewer = await traceServer.startTraceViewerServer({ host: '127.0.0.1', allowedFileRoots: [output] });
  const prefix = viewer.urlPrefix('precise');
  viewerBrowser = await reference.chromium.launch({ executablePath: report.browser.executablePath });
  for (const item of report.cases) {
    const page = await viewerBrowser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    item.viewerErrors = [];
    item.blockedRequests = [];
    page.on('pageerror', error => item.viewerErrors.push(error.message));
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (!url.startsWith(prefix) && !url.startsWith('data:') && !url.startsWith('blob:')) { item.blockedRequests.push(url); await route.abort(); }
      else if (new URL(url).pathname.endsWith('/file') && new URL(url).searchParams.get('path') !== item.path) { item.blockedRequests.push(url); await route.abort(); }
      else await route.continue();
    });
    try {
      await page.goto(`${prefix}/trace/index.html?trace=${encodeURIComponent(`file?path=${encodeURIComponent(item.path)}`)}`);
      await page.getByRole('treeitem', { name: /click/i }).last().click();
      await page.getByRole('tab', { name: 'After', exact: true }).click();
      let snapshot;
      const deadline = Date.now() + 10000;
      while (!snapshot && Date.now() < deadline) {
        snapshot = page.frames().find(frame => {
          const url = new URL(frame.url());
          const parent = item.archive.selectedSnapshots.find(snapshot => snapshot.isMainFrame);
          return url.searchParams.get('name') === item.archive.action.afterSnapshot && [parent.frameId, parent.pageId].some(identity => url.pathname.endsWith('/' + identity));
        });
        if (!snapshot) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(snapshot);
      await snapshot.waitForFunction(() => {
        const child = document.querySelector('#child')?.contentDocument;
        return document.readyState === 'complete' && document.querySelector('#image')?.complete && document.querySelector('#checkpoint') && child?.readyState === 'complete' && child.querySelector('#image')?.complete && child.querySelector('#checkpoint');
      });
      item.replayedState = await snapshot.evaluate(pageState);
      const common = { inlineColor: 'rgb(11, 22, 33)', imageWidth: item.timing === 'during' ? 2 : 0, imageHeight: item.timing === 'during' ? 3 : 0 };
      assert.deepEqual(item.replayedState, {
        parent: { ...common, externalColor: item.timing === 'during' ? 'rgb(60, 80, 100)' : 'rgb(0, 0, 0)', button: 'recorded' },
        child: { ...common, externalColor: item.timing === 'during' ? 'rgb(100, 120, 140)' : 'rgb(0, 0, 0)', button: 'checkpoint' },
      });
      assert.deepEqual(item.viewerErrors, []);
      assert.deepEqual(item.blockedRequests, []);
      item.status = 'passed';
    } finally { await page.screenshot({ path: join(output, `${item.timing}-${item.screenshots}.png`) }); await page.close(); }
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await browser?.close(); await viewerBrowser?.close(); await viewer?.stop();
  if (!originalServerStopped) await new Promise(resolve => application.close(resolve));
  report.browserAfter = await identifyBrowser(report.browser.executablePath);
  assert.deepEqual(report.browserAfter, report.browser);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error, implementation, cases: report.cases.map(item => ({ timing: item.timing, screenshots: item.screenshots, status: item.status })) }));
}
