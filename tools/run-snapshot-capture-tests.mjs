import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { identifyBrowser } from './browser-identity.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { server, utils } = require('playwright-core/lib/coreBundle');
const { TraceWriter } = require('../packages/flashwright-core/dist/commonjs/trace-writer.js');
const { TraceResources } = require('../packages/flashwright-core/dist/commonjs/trace-resources.js');
const directory = resolve(process.argv[2]);
const hash = value => createHash('sha256').update(value).digest('hex');
const source = await readFile(new URL('../packages/resident-runtime/snapshot-runtime.js', import.meta.url), 'utf8');
const report = { status: 'running', scope: 'isolated candidate renderer and host writer with manual fixture action records; no native/public snapshots or network capture claim', sourceSha256: hash(source), archives: [], viewer: [] };
await mkdir(directory);
await writeFile(join(directory, 'snapshot-runtime.js'), source);
await writeFile(join(directory, 'run-snapshot-capture-tests.mjs'), await readFile(new URL(import.meta.url)));
let browser;
let viewerServer;
function state() {
  const shadow = document.querySelector('#shadow').shadowRoot;
  return { text: document.querySelector('#text').value, checked: document.querySelector('#check').checked, selected: document.querySelector('#select').selectedIndex, scrollTop: document.querySelector('#scroll').scrollTop, shadowText: shadow.querySelector('p').textContent, documentColor: getComputedStyle(document.querySelector('.adopted')).color, shadowColor: getComputedStyle(shadow.querySelector('p')).color, inlineColor: getComputedStyle(document.querySelector('.inline')).color };
}
try {
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent('<!doctype html><html><head><style id="inline-style">.inline{color:rgb(31,32,33)}#scroll{width:80px;height:30px;overflow:auto}#scroll div{height:200px}</style></head><body><button id="checkpoint">capture checkpoint</button><p class="adopted">document adopted</p><p class="inline">inline target</p><input id="text" value="initial"><input id="check" type="checkbox"><select id="select"><option>first</option><option>second</option></select><div id="shadow"></div><div id="scroll"><div>scroll target</div></div></body></html>');
  await page.evaluate(`${source}; globalThis.captureOwner = createSnapshotCapture();`);
  await page.evaluate(() => {
    globalThis.documentSheet = new CSSStyleSheet(); documentSheet.replaceSync('.adopted{color:rgb(11,12,13)}');
    globalThis.shadowSheet = new CSSStyleSheet(); shadowSheet.replaceSync('p{color:rgb(21,22,23)}');
    document.adoptedStyleSheets = [documentSheet];
    const shadow = document.querySelector('#shadow').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>shadow initial</p>'; shadow.adoptedStyleSheets = [shadowSheet];
  });
  async function checkpoint(stage) {
    const resources = await TraceResources.create();
    const writer = await TraceWriter.create(resources);
    const path = join(directory, `${stage}.zip`);
    const controller = new AbortController();
    try {
      await page.evaluate(() => captureOwner.reset());
      const startTime = performance.now();
      writer.append({ type: 'context-options', version: 8, origin: 'library', browserName: 'chromium', playwrightVersion: '1.60.0', options: { viewport: { width: 1280, height: 720 } }, platform: process.platform, wallTime: Date.now(), monotonicTime: startTime, sdkLanguage: 'javascript', testIdAttributeName: 'data-testid', contextId: 'browser-context@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', flashwrightExperimentalCaptureSlice: true });
      writer.append({ type: 'before', callId: 'call@1', startTime, class: 'Frame', method: 'click', params: { selector: '#checkpoint', strict: true }, pageId: 'page@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', beforeSnapshot: 'before@call@1' });
      const captures = [];
      for (const [index, phase] of ['before', 'input', 'after'].entries()) {
        if (phase === 'after') await page.locator('#checkpoint').click();
        const snapshotName = `${phase}@call@1`;
        const result = await page.evaluate(({ token, snapshotNumber }) => captureOwner.capture({ token, snapshotNumber }), { token: snapshotName, snapshotNumber: index + 1 });
        assert.deepEqual(result.data.resourceOverrides, [], 'this corpus covers inline/adopted CSS only');
        const snapshot = { callId: 'call@1', snapshotName, pageId: 'page@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', frameId: 'frame@cccccccccccccccccccccccccccccccc', frameUrl: result.data.url, doctype: result.data.doctype, html: result.data.html, viewport: result.data.viewport, timestamp: performance.now(), wallTime: result.data.wallTime, collectionTime: result.data.collectionTime, resourceOverrides: [], isMainFrame: true };
        await writer.appendSnapshot({ type: 'frame-snapshot', snapshot }, controller.signal);
        await page.evaluate(({ token, snapshotNumber }) => captureOwner.commit(token, snapshotNumber), { token: snapshotName, snapshotNumber: index + 1 });
        if (phase === 'input') writer.append({ type: 'input', callId: 'call@1', inputSnapshot: snapshotName });
        captures.push(result);
      }
      const live = await page.evaluate(state);
      writer.append({ type: 'after', callId: 'call@1', endTime: performance.now(), afterSnapshot: 'after@call@1' });
      await writer.finish(path, controller.signal);
      const archive = new utils.ZipFile(path);
      let records;
      try { records = (await archive.read('trace.trace')).toString().trimEnd().split('\n').map(JSON.parse); }
      finally { archive.close(); }
      assert.equal(records.filter(record => record.type === 'frame-snapshot').length, 3);
      report.archives.push({ stage, path, sha256: hash(await readFile(path)), live, captures, records });
      await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
    } finally { await writer.dispose(); await resources.dispose(); }
  }
  await checkpoint('initial');
  await checkpoint('unchanged-successor');
  await page.evaluate(() => {
    document.adoptedStyleSheets = []; document.querySelector('#shadow').shadowRoot.adoptedStyleSheets = [];
    documentSheet.replaceSync('.adopted{color:rgb(51,52,53)}'); shadowSheet.replaceSync('p{color:rgb(61,62,63)}');
  });
  await checkpoint('detached');
  await page.evaluate(() => {
    document.adoptedStyleSheets = [documentSheet]; document.querySelector('#shadow').shadowRoot.adoptedStyleSheets = [shadowSheet];
    document.querySelector('#text').value = 'changed property'; document.querySelector('#check').checked = true; document.querySelector('#select').selectedIndex = 1; document.querySelector('#scroll').scrollTop = 73;
    document.querySelector('#shadow').shadowRoot.querySelector('p').textContent = 'shadow changed';
  });
  await checkpoint('reattached');
  await page.evaluate(async () => { await documentSheet.replace('.adopted{color:rgb(71,72,73)}'); await shadowSheet.replace('p{color:rgb(81,82,83)}'); document.querySelector('#inline-style').sheet.disabled = true; });
  await checkpoint('async-replaced-disabled');
  await page.evaluate(() => { document.querySelector('#inline-style').sheet.disabled = false; documentSheet.replaceSync('.adopted{color:rgb(91,92,93)}'); });
  await checkpoint('after-gap');
  await browser.close(); browser = undefined;

  viewerServer = await server.startTraceViewerServer({ host: '127.0.0.1', allowedFileRoots: [directory] });
  const prefix = viewerServer.urlPrefix('precise');
  browser = await chromium.launch({ executablePath: report.browser.executablePath });
  for (const archive of report.archives) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const item = { stage: archive.stage, errors: [], blocked: [], expected: archive.live };
    report.viewer.push(item);
    page.on('pageerror', error => item.errors.push(error.message));
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (!url.startsWith(prefix) && !url.startsWith('data:') && !url.startsWith('blob:')) { item.blocked.push(url); await route.abort(); }
      else if (new URL(url).pathname.endsWith('/file') && new URL(url).searchParams.get('path') !== archive.path) { item.blocked.push(url); await route.abort(); }
      else await route.continue();
    });
    try {
      await page.goto(`${prefix}/trace/index.html?trace=${encodeURIComponent(`file?path=${encodeURIComponent(archive.path)}`)}`);
      await page.getByRole('treeitem', { name: /click/i }).last().click();
      await page.getByRole('tab', { name: 'After', exact: true }).click();
      let frame;
      const deadline = Date.now() + 10000;
      while (!frame && Date.now() < deadline) {
        for (const candidate of page.frames()) if (await candidate.locator('#text').count().catch(() => 0)) { frame = candidate; break; }
        if (!frame) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(frame, `${archive.stage}: actual viewer frame`);
      item.actual = await frame.evaluate(state);
      assert.deepEqual(item.actual, item.expected, `${archive.stage}: live state equals standalone replay`);
      assert.deepEqual(item.errors, []); assert.deepEqual(item.blocked, []);
      item.status = 'passed';
    } finally { await page.screenshot({ path: join(directory, `${archive.stage}-viewer.png`) }); await page.close(); }
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await browser?.close(); await viewerServer?.stop(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(join(directory, 'report.json')); }
