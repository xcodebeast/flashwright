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
const cases = ['global-defined', 'global-undefined', 'failed-only', 'failed-and-defined', 'scoped-defined', 'scoped-undefined', 'scoped-mixed', 'scoped-two-definitions', 'customized-built-in', 'outside-body'];
const report = { status: 'running', scope: 'helper serializer custom-element tests; public/native fidelity has separate acceptance', sourceSha256: hash(source), captures: [], archives: [], viewer: [] };
await mkdir(directory);
for (const [name, content] of [['snapshot-runtime.js', source], ['test-snapshot-custom-elements.mjs', await readFile(new URL(import.meta.url))]]) await writeFile(join(directory, name), content);
let browser;
let viewerServer;

/** Observe each instance, including scoped shadow trees, without consulting registries. */
function state() {
  const elements = [];
  function visit(root) {
    for (const element of root.querySelectorAll('*')) {
      if (element.hasAttribute('data-probe')) elements.push({ id: element.id, defined: element.matches(':defined'), color: getComputedStyle(element).color, text: element.textContent });
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  }
  visit(document);
  return elements.sort((left, right) => left.id.localeCompare(right.id));
}

/** Build failed upgrades and scoped registries through browser-native operations. */
function setup(label) {
  const style = 'x-probe:defined{color:rgb(21,22,23)}x-probe:not(:defined){color:rgb(61,62,63)}';
  document.head.innerHTML = `<style>${style}</style>`;
  document.body.innerHTML = '<button id="checkpoint">checkpoint</button>';
  const elementMarkup = id => `<x-probe id="${id}" data-probe>${id}</x-probe>`;
  if (label.startsWith('scoped-')) {
    const firstRegistry = new CustomElementRegistry();
    if (label !== 'scoped-undefined') firstRegistry.define('x-probe', class extends HTMLElement {});
    const firstHost = document.createElement('div'); document.body.append(firstHost);
    const firstRoot = firstHost.attachShadow({ mode: 'open', customElementRegistry: firstRegistry });
    firstRoot.innerHTML = `<style>${style}</style>${elementMarkup('first')}`;
    if (label === 'scoped-mixed' || label === 'scoped-two-definitions') {
      const secondRegistry = new CustomElementRegistry();
      if (label === 'scoped-two-definitions') secondRegistry.define('x-probe', class extends HTMLElement {});
      const secondHost = document.createElement('div'); document.body.append(secondHost);
      const secondRoot = secondHost.attachShadow({ mode: 'open', customElementRegistry: secondRegistry });
      secondRoot.innerHTML = `<style>${style}</style>${elementMarkup('second')}`;
    }
    return { scoped: firstRoot.customElementRegistry === firstRegistry };
  }
  if (label === 'customized-built-in') {
    customElements.define('x-button', class extends HTMLButtonElement {}, { extends: 'button' });
    const button = document.createElement('button', { is: 'x-button' }); button.setAttribute('is', 'x-button'); button.id = 'first'; button.setAttribute('data-probe', ''); button.textContent = 'first'; document.body.append(button);
    return { scoped: false };
  }
  if (label === 'outside-body') {
    customElements.define('x-probe', class extends HTMLElement {});
    const element = document.createElement('x-probe'); element.id = 'first'; element.setAttribute('data-probe', ''); element.textContent = 'first'; document.documentElement.append(element);
    return { scoped: false };
  }
  document.body.insertAdjacentHTML('beforeend', elementMarkup('first'));
  if (label === 'global-defined') customElements.define('x-probe', class extends HTMLElement {});
  if (label.startsWith('failed-')) {
    let shouldFail = true;
    customElements.define('x-probe', class extends HTMLElement { constructor() { super(); if (shouldFail) throw new Error('intentional failed custom element constructor'); } });
    if (label === 'failed-and-defined') {
      shouldFail = false;
      const element = document.createElement('x-probe'); element.id = 'second'; element.setAttribute('data-probe', ''); element.textContent = 'second'; document.body.append(element);
    }
  }
  return { scoped: false };
}

async function archiveCapture(label, world, variant, captured, successor, live) {
  const resources = await TraceResources.create();
  const writer = await TraceWriter.create(resources);
  const path = join(directory, `${label}-${world}-${variant}.zip`);
  const controller = new AbortController();
  const startTime = performance.now();
  try {
    writer.append({ type: 'context-options', version: 8, origin: 'library', browserName: 'chromium', playwrightVersion: '1.60.0', options: { viewport: { width: 1280, height: 720 } }, platform: process.platform, wallTime: Date.now(), monotonicTime: startTime, sdkLanguage: 'javascript', testIdAttributeName: 'data-testid', contextId: 'browser-context@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', flashwrightExperimentalCaptureSlice: true });
    writer.append({ type: 'before', callId: 'call@1', startTime, class: 'Frame', method: 'click', params: { selector: '#checkpoint', strict: true }, pageId: 'page@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', beforeSnapshot: 'before@call@1' });
    for (const phase of ['before', 'after']) {
      const snapshot = { ...(phase === 'before' ? captured.data : successor.data), callId: 'call@1', snapshotName: `${phase}@call@1`, pageId: 'page@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', frameId: 'frame@cccccccccccccccccccccccccccccccc', frameUrl: captured.data.url, timestamp: performance.now(), isMainFrame: true };
      delete snapshot.url;
      await writer.appendSnapshot({ type: 'frame-snapshot', snapshot }, controller.signal);
    }
    writer.append({ type: 'after', callId: 'call@1', endTime: performance.now(), afterSnapshot: 'after@call@1' });
    await writer.finish(path, controller.signal);
    const archive = new utils.ZipFile(path);
    try { assert.equal((await archive.read('trace.trace')).toString().trimEnd().split('\n').map(JSON.parse).filter(record => record.type === 'frame-snapshot').length, 2); }
    finally { archive.close(); }
    report.archives.push({ label, world, variant, path, sha256: hash(await readFile(path)), live });
  } finally { await writer.dispose(); await resources.dispose(); }
}

try {
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  browser = await chromium.launch({ executablePath: report.browser.executablePath });
  for (const label of cases) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    try {
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<!doctype html><html><head></head><body></body></html>');
      const features = await page.evaluate(setup, label);
      if (label.startsWith('scoped-')) assert.equal(features.scoped, true, 'scoped registry must actually be installed');
      const live = await page.evaluate(state);
      assert.equal(live.length, ['failed-and-defined', 'scoped-mixed', 'scoped-two-definitions'].includes(label) ? 2 : 1);
      const expectedStates = label === 'failed-and-defined' ? [false, true] : label === 'scoped-mixed' ? [true, false] : live.map(() => ['global-defined', 'scoped-defined', 'scoped-two-definitions', 'customized-built-in', 'outside-body'].includes(label));
      assert.deepEqual(live.map(element => element.defined), expectedStates, 'fixture has intended native state');
      assert.equal(errors.length, label.startsWith('failed-') ? 1 : 0);
      const session = await context.newCDPSession(page);
      const frame = (await session.send('Page.getFrameTree')).frameTree.frame;
      const isolated = await session.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: '__flashwright_locator_world__' });
      for (const world of [{ name: 'main' }, { name: 'isolated', contextId: isolated.executionContextId }]) {
        const variant = 'candidate';
        const reply = await session.send('Runtime.evaluate', { expression: `(() => { ${source}; const owner = createSnapshotCapture(); const first = owner.capture({token:'first',snapshotNumber:1}); owner.commit('first',1); const second = owner.capture({token:'second',snapshotNumber:2}); owner.commit('second',2); return {first,second}; })()`, ...(world.contextId === undefined ? {} : { contextId: world.contextId }), returnByValue: true });
        const result = reply.result.value?.first;
        const successor = reply.result.value?.second;
        const error = reply.exceptionDetails?.exception?.description ?? reply.exceptionDetails?.text;
        const mixed = ['failed-and-defined', 'scoped-mixed'].includes(label);
        const expectedUnsupported = mixed || ['customized-built-in', 'outside-body'].includes(label);
        const item = { label, world: world.name, variant, features, live, applicationErrors: errors, error, result, successor };
        report.captures.push(item);
        if (expectedUnsupported) {
          const message = mixed ? 'one custom element name has mixed defined states' : label === 'customized-built-in' ? 'customized built-in element markers are not supported' : 'custom elements outside BODY are not supported';
          assert.ok(error?.includes(`SnapshotUnsupported: ${message}`));
        }
        else {
          assert.equal(error, undefined); assert.ok(result && successor); assert.deepEqual(result.data.resourceOverrides, []);
          // Replay every accepted isolated capture through the actual pinned viewer.
          if (world.name === 'isolated') await archiveCapture(label, world.name, variant, result, successor, live);
        }
      }
      await session.detach();
    } finally { await context.close(); }
  }
  await browser.close(); browser = undefined;
  viewerServer = await server.startTraceViewerServer({ host: '127.0.0.1', allowedFileRoots: [directory] });
  const prefix = viewerServer.urlPrefix('precise');
  browser = await chromium.launch({ executablePath: report.browser.executablePath });
  for (const archive of report.archives) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const item = { label: archive.label, world: archive.world, variant: archive.variant, errors: [], blocked: [], expected: archive.live };
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
        for (const candidate of page.frames()) if (await candidate.locator('#checkpoint').count().catch(() => 0)) { frame = candidate; break; }
        if (!frame) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(frame, 'actual viewer frame loaded');
      item.actual = await frame.evaluate(state);
      item.matches = JSON.stringify(item.actual) === JSON.stringify(item.expected);
      assert.deepEqual(item.actual, item.expected, 'accepted isolated capture preserves per-instance live state');
      assert.deepEqual(item.errors, []); assert.deepEqual(item.blocked, []);
      item.status = 'passed';
    } finally { await page.screenshot({ path: join(directory, `${archive.label}-${archive.world}-${archive.variant}-viewer.png`) }); await page.close(); }
  }
  report.status = 'passed-with-declared-unsupported-cases';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await browser?.close(); await viewerServer?.stop(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(join(directory, 'report.json')); }
