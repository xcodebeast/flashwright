import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { identifyBrowser } from './browser-identity.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('../packages/flashwright-core/dist/commonjs/index.js');
const { iso, utils } = require('playwright-core/lib/coreBundle');
const output = resolve(process.argv[2]);
await mkdir(output);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', scope: 'Public manual snapshot phases, original chunk ownership and typed export failures. Network replay has a separate original-server-off viewer corpus.', checks: [], archives: [], browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH) };
const server = createServer((request, response) => {
  if (request.url === '/style.css') { response.setHeader('content-type', 'text/css'); response.end('button { color: rgb(20, 40, 60); }'); return; }
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><button id="button" onclick="this.textContent=\'clicked\'">before</button><input id="input"><select id="select"><option value="one">One</option><option value="two">Two</option></select><iframe srcdoc="<!doctype html><body><p>child-content</p>"></iframe></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
async function startSnapshots(tracing, options = {}) { await tracing.start({ snapshots: true, ...options }); }
async function check(name, callback) { await callback(); report.checks.push(name); }
async function inspect(path) {
  const archive = new utils.ZipFile(path);
  try {
    const names = await archive.entries();
    const loader = new iso.TraceLoader();
    await loader.load({ entryNames: async () => names, readText: async name => names.includes(name) ? (await archive.read(name)).toString() : undefined, hasEntry: async name => names.includes(name), isLive: () => false });
    const events = (await archive.read('trace.trace')).toString().trim().split('\n').map(JSON.parse);
    const context = loader.contextEntries[0];
    assert.equal(loader.contextEntries.length, 1);
    const snapshots = events.filter(event => event.type === 'frame-snapshot').map(event => event.snapshot);
    const result = { path, sha256: hash(await readFile(path)), entries: names, events, actions: context.actions, snapshotCount: snapshots.length };
    report.archives.push(result);
    return { ...result, snapshots };
  } finally { archive.close(); }
}
try {
  browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  await check('public snapshot validation rejects invalid values before a fresh valid recording', async () => {
    const context = await browser.newContext();
    try {
      await assert.rejects(context.tracing.start({ snapshots: 'true' }), { name: 'InvalidArgumentError' });
      await startSnapshots(context.tracing);
      await context.tracing.stop();
    }
    finally { await context.close(); }
  });
  for (const screenshots of [false, true]) {
    await check(`actual journal links native phases with independent clock samples, screenshots=${screenshots}`, async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage(); await page.goto(origin);
        await startSnapshots(context.tracing, { screenshots });
        await page.locator('#button').click();
        await page.locator('#input').fill('filled');
        await page.locator('#select').selectOption('two');
        const path = join(output, `actions-${screenshots}.zip`);
        await context.tracing.stop({ path });
        const trace = await inspect(path);
        assert.equal(trace.actions.length, 3);
        assert.equal(trace.events.filter(event => event.type === 'input').length, 3);
        for (const action of trace.actions) {
          assert.equal(action.beforeSnapshot, `before@${action.callId}`);
          assert.equal(action.inputSnapshot, `input@${action.callId}`);
          assert.equal(action.afterSnapshot, `after@${action.callId}`);
          for (const name of [action.beforeSnapshot, action.inputSnapshot, action.afterSnapshot]) {
            const frames = trace.snapshots.filter(snapshot => snapshot.snapshotName === name);
            assert.equal(frames.length, 2);
            assert.equal(frames.filter(snapshot => snapshot.isMainFrame).length, 1);
          }
        }
        const options = trace.events.find(event => event.type === 'context-options');
        assert.equal(typeof options.flashwrightRecordingClock.offset, 'number');
        assert.ok(options.flashwrightRecordingClock.uncertainty >= 0);
        assert.equal(Object.hasOwn(options, 'flashwrightClock'), screenshots);
        if (screenshots) assert.ok(trace.events.some(event => event.type === 'screencast-frame'));
        assert.ok(trace.entries.some(name => name.endsWith('.css')));
        assert.equal(await page.locator('#input').inputValue(), 'filled');
        // A completed native recording must not prevent an independent successor.
        await startSnapshots(context.tracing);
        await page.title();
        await context.tracing.stop();
      } finally { await context.close(); }
    });
  }
  await check('Unicode snapshots preserve native wire escapes, lone UTF-16 and incremental replay', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage(); await page.goto(origin);
      const input = 'métadonnées Δ 😀 '.repeat(128);
      const text = input + '\ud800A\udfff';
      await page.evaluate(text => {
        const element = document.createElement('p');
        element.id = 'unicode'; element.title = text; element.textContent = text;
        document.body.appendChild(element);
      }, text);
      await startSnapshots(context.tracing);
      await page.locator('#input').fill(input);
      assert.equal(await page.locator('#unicode').textContent(), text);
      const path = join(output, 'unicode.zip');
      await context.tracing.stop({ path });
      const trace = await inspect(path);
      const storage = new iso.SnapshotStorage();
      const main = trace.snapshots.filter(snapshot => snapshot.isMainFrame);
      assert.ok(main.length >= 4);
      let finalHtml;
      for (const snapshot of main) {
        const html = storage.addFrameSnapshot('context', snapshot, []).render().html;
        assert.ok(html.includes(text), 'literal and incremental snapshots preserve exact UTF-16 text');
        assert.ok(html.includes(`title="${text}"`));
        finalHtml = html;
      }
      assert.ok(finalHtml.includes(`__playwright_value_="${input}"`));
      assert.equal(await page.locator('#input').inputValue(), input);
    } finally { await context.close(); }
  });
  await check('chunk gaps keep one native recording and late old calls cannot acquire a successor', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage(); await page.goto(origin);
      await startSnapshots(context.tracing);
      const originalRecording = context.tracing.nativeRecording.identifier;
      const oldChunk = context.tracing.chunk.identifier;
      let release;
      const blocked = new Promise(resolve => { release = resolve; });
      const originalRequest = context.client.request;
      let waiting;
      const entered = new Promise(resolve => { waiting = resolve; });
      context.client.request = function(method, parameters, ...rest) {
        if (method === 'page.evaluate') { waiting(); return blocked.then(() => originalRequest.call(this, method, parameters, ...rest)); }
        return originalRequest.call(this, method, parameters, ...rest);
      };
      const late = page.evaluate(() => 7);
      await entered;
      await context.tracing.stopChunk({ path: join(output, 'old-chunk.zip') });
      await context.tracing.startChunk();
      assert.equal(context.tracing.nativeRecording.identifier, originalRecording);
      assert.notEqual(context.tracing.chunk.identifier, oldChunk);
      release(); assert.equal(await late, 7);
      context.client.request = originalRequest;
      await page.locator('#input').fill('successor');
      await context.tracing.stop({ path: join(output, 'new-chunk.zip') });
      const oldTrace = await inspect(join(output, 'old-chunk.zip'));
      const newTrace = await inspect(join(output, 'new-chunk.zip'));
      const oldCall = oldTrace.actions.find(action => action.method === 'evaluateExpression');
      assert.ok(oldCall);
      assert.equal(oldCall.endTime, 0);
      assert.ok(!newTrace.events.some(event => event.callId === oldCall.callId || event.snapshot?.callId === oldCall.callId));
    } finally { await context.close(); }
  });
  await check('failed snapshot export preserves the destination and allows a fresh recording after cleanup', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage(); await page.goto(origin);
      await page.evaluate(() => { const fragment = document.createDocumentFragment(); for (let index = 0; index < 25001; index++) fragment.appendChild(document.createTextNode('x')); document.body.appendChild(fragment); });
      await startSnapshots(context.tracing);
      await page.locator('#input').fill('survived');
      const path = join(output, 'preserved.zip'); await writeFile(path, 'original-destination');
      await assert.rejects(context.tracing.stop({ path }), { name: 'ResourceLimitError' });
      assert.equal(await readFile(path, 'utf8'), 'original-destination');
      assert.equal(await page.locator('#input').inputValue(), 'survived');
      await page.goto(origin);
      await startSnapshots(context.tracing);
      await page.locator('#input').fill('fresh');
      await context.tracing.stop({ path: join(output, 'fresh.zip') });
      await inspect(join(output, 'fresh.zip'));
    } finally { await context.close(); }
  });
  await check('unsupported custom-element snapshots fail export without changing the public action or destination', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage(); await page.goto(origin);
      await page.evaluate(() => document.querySelector('#button').setAttribute('is', 'custom-button'));
      await startSnapshots(context.tracing);
      await page.locator('#input').fill('original-action-completed');
      const path = join(output, 'unsupported-preserved.zip'); await writeFile(path, 'original-destination');
      await assert.rejects(context.tracing.stop({ path }), error => error.name === 'UnsupportedFeatureError' && error.message.includes('customized built-in'));
      assert.equal(await readFile(path, 'utf8'), 'original-destination');
      assert.equal(await page.locator('#input').inputValue(), 'original-action-completed');
      await page.evaluate(() => document.querySelector('#button').removeAttribute('is'));
      await startSnapshots(context.tracing);
      await page.locator('#input').fill('fresh-after-unsupported');
      await context.tracing.stop({ path: join(output, 'after-unsupported.zip') });
      await inspect(join(output, 'after-unsupported.zip'));
    } finally { await context.close(); }
  });
  await check('cross-origin frames preserve captured documents across renderer placement', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage(); await page.goto(origin);
      await page.evaluate(async remote => {
        document.querySelector('iframe').remove();
        const child = document.createElement('iframe');
        const loaded = new Promise(resolve => child.onload = resolve);
        child.src = remote; document.body.append(child); await loaded;
      }, origin.replace('127.0.0.1', 'localhost') + '/remote');
      const child = page.frames().find(frame => frame !== page.mainFrame());
      assert.ok(child);
      let remote = false;
      try { await child.locator('body').ariaSnapshot(); }
      catch (error) { assert.equal(error.name, 'UnsupportedFeatureError'); remote = true; }
      report.crossOriginFramePlacement = remote ? 'out-of-process' : 'same-process';
      await startSnapshots(context.tracing);
      await page.locator('#input').fill('frame-action-completed');
      const path = join(output, 'cross-origin.zip'); await writeFile(path, 'original-destination');
      await context.tracing.stop({ path });
      const trace = await inspect(path);
      assert.ok(trace.snapshots.some(snapshot => snapshot.frameUrl.includes('localhost')));
      assert.equal(await page.locator('#input').inputValue(), 'frame-action-completed');
    } finally { await context.close(); }
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await browser?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  report.browserAfter = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  assert.deepEqual(report.browserAfter, report.browser);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks, error: report.error }));
}
