import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium as candidate } from 'flashwright';
import { chromium as reference } from 'playwright';
import { sourceManifest } from './source-manifest.mjs';

const output = resolve(process.argv[2]); await mkdir(output);
const selected = process.argv[3] ?? 'both';
assert(['both', 'candidate', 'reference'].includes(selected));
const require = createRequire(import.meta.url);
const { iso, utils, server: traceServer } = require('playwright-core/lib/coreBundle');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH;
const actualBrowser = process.env.FLASHWRIGHT_PROFILE_BROWSER_PATH ?? browserPath;
assert(browserPath && actualBrowser);
const report = { status: 'running', scope: 'Remote DOM snapshot archives, nested frame mappings, renderer transitions and actual offline viewer replay. Functional coverage, not performance acceptance.',
  sources: await sourceManifest(), browserSha256: hash(await readFile(actualBrowser)), driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), cases: [] };
const idle = ms => new Promise(resolve => setTimeout(resolve, ms));
let port, browser, viewer, viewerBrowser;
const application = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end('#state { color: rgb(20, 40, 60) }'); return; }
  if (url.pathname === '/pixel.svg') { response.setHeader('Content-Type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"/>'); return; }
  response.setHeader('Content-Type', 'text/html');
  const kind = url.pathname.slice(1), round = url.searchParams.get('round') ?? '1';
  const nested = kind === 'root' ? `<iframe id="child" src="http://localhost:${port}/child?round=1"></iframe>`
    : kind === 'child' ? `<iframe id="nested" src="http://${url.hostname === 'localhost' ? '127.0.0.1' : 'localhost'}:${port}/nested?round=${round}"></iframe>` : '';
  response.end(`<!doctype html><link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css"><body data-kind="${kind}" data-round="${round}"><input id="input"><p id="state">${kind}:initial</p><img id="image" src="/pixel.svg">${nested}<script>document.querySelector('#input').oninput=e=>document.querySelector('#state').textContent='${kind}:'+e.target.value;</script></body>`);
});
function state() {
  return { kind: document.body.dataset.kind, round: document.body.dataset.round,
    input: document.querySelector('#input').value, text: document.querySelector('#state').textContent,
    color: getComputedStyle(document.querySelector('#state')).color,
    image: [document.querySelector('#image').naturalWidth, document.querySelector('#image').naturalHeight] };
}
async function inspect(item) {
  const archive = new utils.ZipFile(item.path);
  try {
    const records = (await archive.read('trace.trace')).toString().trim().split('\n').map(JSON.parse);
    const loader = new iso.TraceLoader(), entries = await archive.entries();
    await loader.load({ entryNames: async () => entries, readText: async name => entries.includes(name) ? (await archive.read(name)).toString() : undefined, hasEntry: async name => entries.includes(name), isLive: () => false });
    const fills = loader.contextEntries[0].actions.filter(action => action.method === 'fill');
    assert.equal(fills.length, 10);
    const storage = new iso.SnapshotStorage(), rendered = new Map();
    for (const { snapshot } of records.filter(record => record.type === 'frame-snapshot')) {
      rendered.set(`${snapshot.snapshotName}:${snapshot.frameId}`, storage.addFrameSnapshot('context', snapshot, []).render().html);
    }
    item.actions = [];
    for (let index = 0; index < fills.length; index++) {
      const action = fills[index]; assert(!action.error);
      const snapshots = records.filter(record => record.type === 'frame-snapshot' && record.snapshot.snapshotName === action.afterSnapshot).map(record => record.snapshot);
      assert.equal(snapshots.length, index < 9 ? 3 : 1, `fill ${index} retains exactly the participating documents`);
      assert.equal(snapshots.filter(snapshot => snapshot.isMainFrame).length, 1);
      assert.equal(new Set(snapshots.map(snapshot => snapshot.frameId)).size, snapshots.length);
      let unavailableNestedMapping = false;
      for (const snapshot of snapshots) {
        const kind = new URL(snapshot.frameUrl).pathname.slice(1);
        const html = rendered.get(`${snapshot.snapshotName}:${snapshot.frameId}`);
        assert(html.includes(`data-kind="${kind}"`));
        const missing = html.match(/<IFRAME\b[^>]*__playwright_src__=""[^>]*>/gi) ?? [];
        if (missing.length) {
          assert.equal(item.engine, 'reference', 'Candidate must retain every original iframe mapping');
          assert.equal(kind, 'child'); assert.equal(missing.length, 1);
          assert(/\bid="nested"/.test(missing[0]));
          unavailableNestedMapping = true;
        }
        if (index < 9 && kind === ['root', 'child', 'nested'][index % 3]) {
          assert(html.includes(`${kind}:round-${Math.floor(index / 3) + 1}`), `fill ${index} preserves changed state in ${kind}`);
        }
        if (index === 9) assert(html.includes('root:removed'));
      }
      item.actions.push({ callId: action.callId, afterSnapshot: action.afterSnapshot, unavailableNestedMapping, frames: snapshots.map(({ frameId, pageId, frameUrl, isMainFrame }) => ({ frameId, pageId, frameUrl, isMainFrame })) });
    }
    item.archiveSha256 = hash(await readFile(item.path));
  } finally { archive.close(); }
}
try {
  application.listen(0, '0.0.0.0'); await once(application, 'listening'); port = application.address().port;
  for (const [name, engine] of [['reference', reference], ['candidate', candidate]]) {
    if (selected !== 'both' && selected !== name) continue;
    const item = { engine: name, path: join(output, `${name}.zip`), rounds: [] }; report.cases.push(item);
    browser = await engine.launch({ executablePath: browserPath });
    const context = await browser.newContext();
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    await context.tracing.start({ snapshots: true, screenshots: false, sources: false });
    await page.goto(`http://127.0.0.1:${port}/root`);
    for (let round = 1; round <= 3; round++) {
      if (round > 1) await page.evaluate(({ port, round }) => {
        document.querySelector('#child').src = `http://${round === 2 ? '127.0.0.1' : 'localhost'}:${port}/child?round=${round}`;
      }, { port, round });
      const child = page.frameLocator('#child'), nested = child.frameLocator('#nested');
      for (const frame of [child, nested]) {
        const deadline = Date.now() + 5000;
        while (await frame.locator('body').getAttribute('data-round') !== String(round)) {
          assert(Date.now() < deadline, 'new document readiness'); await idle(10);
        }
      }
      for (const frame of [page, child, nested]) await frame.locator('#input').fill(`round-${round}`);
      const states = [];
      for (const frame of [page, child, nested]) states.push(await frame.locator('body').evaluate(state));
      assert.deepEqual(states.map(value => value.input), Array(3).fill(`round-${round}`));
      assert(states.every(value => value.color === 'rgb(20, 40, 60)' && value.image[0] === 7 && value.image[1] === 9));
      item.rounds.push(states);
    }
    await page.evaluate(() => document.querySelector('#child').remove());
    await page.locator('#input').fill('removed');
    await context.tracing.stop({ path: item.path });
    await context.close(); await browser.close(); browser = undefined;
    await inspect(item);
  }
  application.closeAllConnections(); await new Promise(resolve => application.close(resolve));
  report.originalApplicationStoppedBeforeReplay = true;
  const protocol = process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY;
  assert(protocol, 'Use run-remote-snapshot-tests.mjs to retain actual renderer placement');
  report.protocol = [];
  for (const name of (await readdir(protocol)).filter(name => name.endsWith('.jsonl'))) {
    const bytes = await readFile(join(protocol, name));
    const rows = bytes.toString().trim().split('\n').map(JSON.parse);
    const sessions = new Set(rows.filter(row => row.kind === 'networkOwnership' && row.method === 'Target.attachedToTarget' && row.parameters.targetInfo.type === 'iframe').map(row => row.parameters.sessionId));
    assert(sessions.size >= 4, 'The shared browser fixture must actually use nested remote renderers and replacement sessions');
    const operations = rows.filter(row => row.kind === 'snapshotOwnership' && sessions.has(row.sessionId));
    const remoteFactories = new Set(operations.filter(row => row.operation === 'factory').map(row => row.sessionId));
    report.protocol.push({ file: name, sha256: hash(bytes), remoteSessions: sessions.size, remoteFactories: remoteFactories.size,
      remoteCaptures: operations.filter(row => row.operation === 'capture').length,
      remoteDecisions: operations.filter(row => row.operation === 'decisionOrRetirement').length,
      remoteParentLookups: operations.filter(row => row.operation === 'DOM.getFrameOwner').length });
  }
  if (selected !== 'reference') assert(report.protocol.some(item => item.remoteFactories >= 4 && item.remoteCaptures >= 12 && item.remoteDecisions >= 12 && item.remoteParentLookups > 0));
  viewer = await traceServer.startTraceViewerServer({ host: '127.0.0.1', allowedFileRoots: [output] });
  const prefix = viewer.urlPrefix('precise');
  viewerBrowser = await reference.launch({ executablePath: actualBrowser });
  for (const item of report.cases) {
    item.replays = [];
    const page = await viewerBrowser.newPage(); page.setDefaultTimeout(10000);
    const errors = [], blocked = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (!url.startsWith(prefix) && !url.startsWith('data:') && !url.startsWith('blob:')) { blocked.push(url); await route.abort(); }
      else if (new URL(url).pathname.endsWith('/file') && new URL(url).searchParams.get('path') !== item.path) { blocked.push(url); await route.abort(); }
      else await route.continue();
    });
    await page.goto(`${prefix}/trace/index.html?trace=${encodeURIComponent(`file?path=${encodeURIComponent(item.path)}`)}`);
    for (const index of [2, 5, 8, 9]) {
      await page.getByRole('treeitem', { name: /fill/i }).nth(index).click();
      await page.getByRole('tab', { name: 'After', exact: true }).click();
      const action = item.actions[index], original = action.frames.find(frame => frame.isMainFrame);
      let snapshot;
      const deadline = Date.now() + 10000;
      while (!snapshot) {
        snapshot = page.frames().find(frame => {
          const url = new URL(frame.url());
          return url.searchParams.get('name') === action.afterSnapshot && [original.frameId, original.pageId].some(id => url.pathname.endsWith('/' + id));
        });
        assert(Date.now() < deadline, 'viewer must open selected snapshot');
        if (!snapshot) await idle(20);
      }
      await snapshot.waitForFunction(() => document.querySelector('#state') && document.querySelector('#image')?.complete);
      const frames = [snapshot];
      if (index < 9) {
        await snapshot.frameLocator('#child').locator('#input').waitFor();
        frames.push(snapshot.childFrames()[0]);
        if (!action.unavailableNestedMapping) {
          await snapshot.frameLocator('#child').frameLocator('#nested').locator('#input').waitFor();
          frames.push(snapshot.childFrames()[0].childFrames()[0]);
        }
      }
      const states = await Promise.all(frames.map(frame => frame.evaluate(state)));
      assert.deepEqual(states, index < 9 ? item.rounds[Math.floor(index / 3)].slice(0, frames.length) : [{ ...item.rounds[2][0], input: 'removed', text: 'root:removed' }]);
      item.replays.push({ index, states, ...(action.unavailableNestedMapping ? { referenceDifference: 'Nested document is archived, but the parent iframe snapshot link is empty. Linked nested replay is unavailable; only the root and child replay states are accepted.' } : {}) });
    }
    assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
    await page.close();
  }
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(actualBrowser)), report.browserSha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  if (report.status === 'failed' && viewerBrowser) {
    for (const [index, page] of viewerBrowser.contexts().flatMap(context => context.pages()).entries()) {
      await writeFile(join(output, `failed-viewer-${index}.txt`), await page.locator('body').ariaSnapshot().catch(String));
      await page.screenshot({ path: join(output, `failed-viewer-${index}.png`) }).catch(() => {});
    }
  }
  await browser?.close(); await viewerBrowser?.close(); await viewer?.stop();
  application.closeAllConnections(); if (application.listening) await new Promise(resolve => application.close(resolve));
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, error: report.error, cases: report.cases.map(item => ({ engine: item.engine, replays: item.replays?.length })) }));
}
