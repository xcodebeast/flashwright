import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { identifyBrowser } from './browser-identity.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';

const require = createRequire(import.meta.url);
const { iso, utils } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const destination = resolve(`compatibility/evidence/manual-tracing-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath();
const driverPath = process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver');
process.env.FLASHWRIGHT_DRIVER_PATH = driverPath;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(destination, { recursive: true });
const report = { status: 'running', ...runtimeMetadata, browser: await identifyBrowser(browserPath), driverSha256: hash(await readFile(driverPath)), sources: await sourceManifest(), outcomes: {} };

async function inspectTrace(path) {
  execFileSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as archive: assert archive.testzip() is None', path]);
  const archive = new utils.ZipFile(path);
  try {
    const names = await archive.entries();
    assert.ok(names.includes('trace.trace'));
    assert.ok(!names.some(name => name.startsWith('resources/')), 'no unrequested snapshots, screenshots or source files');
    const loader = new iso.TraceLoader();
    await loader.load({ entryNames: async () => names, readText: async name => names.includes(name) ? (await archive.read(name)).toString() : undefined, hasEntry: async name => names.includes(name), isLive: () => false });
    assert.equal(loader.contextEntries.length, 1);
    assert.equal(loader.contextEntries[0].hasSource, false);
    const events = (await archive.read('trace.trace')).toString().trim().split('\n').map(JSON.parse);
    const entry = loader.contextEntries[0];
    assert.ok(entry.actions.every(action => action.stack?.some(location => location.file.endsWith('run-manual-trace-tests.mjs'))), 'every public action has its caller location');
    return { entries: names, events, actions: entry.actions, sha256: hash(await readFile(path)) };
  } finally { archive.close(); }
}

async function exercise(library, directory) {
  const { chromium } = await import(library);
  const browser = await chromium.launch({ executablePath: browserPath });
  const outcomes = {};
  try {
    const context = await browser.newContext();
    await context.tracing.start({ screenshots: false, snapshots: false, sources: false, title: 'Manual trace conformance' });
    const registration = await context.addInitScript(() => console.log('initial script diagnostic'));
    const page = await context.newPage();
    assert.equal(await page.evaluate(() => { console.log('inside evaluate'); return 42; }), 42);
    await assert.rejects(page.evaluate(() => { throw new Error('trace browser failure'); }));
    await Promise.all([page.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return 1; }), page.title()]);
    await page.evaluate(() => { document.body.innerHTML = '<input id="name"><button id="button">Run</button>'; });
    await page.locator('#name').fill('traced text');
    assert.equal(await page.locator('#name').inputValue(), 'traced text');
    const selected = await page.waitForSelector('#name');
    await selected.dispose();
    const frameSelected = await page.mainFrame().waitForSelector('#name');
    await frameSelected.dispose();
    assert.equal(await page.locator('#name').evaluate(element => element.value), 'traced text');
    const evaluated = await page.locator('#name').evaluateHandle(element => element);
    await evaluated.dispose();
    await page.locator('#name').pressSequentially('A');
    await page.keyboard.type('é');
    assert.equal(await page.locator('#name').inputValue(), 'traced textAé');
    const located = await page.locator('#name').elementHandle();
    await located.selectText();
    await located.scrollIntoViewIfNeeded();
    await located.dispose();
    await page.locator('#name').selectText();
    await page.locator('#name').scrollIntoViewIfNeeded();
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'file'; document.body.append(input); });
    await page.setInputFiles('#file', { name: 'trace.txt', mimeType: '', buffer: Buffer.from('trace') });
    await page.mainFrame().setInputFiles('#file', []);
    await page.locator('#file').setInputFiles([]);
    const fileInput = await page.evaluateHandle(() => document.querySelector('#file'));
    await fileInput.setInputFiles([]);
    await fileInput.dispose();
    const chooserOpened = page.waitForEvent('filechooser');
    await page.locator('#file').click();
    const chooser = await chooserOpened;
    await chooser.setFiles({ name: 'chooser.txt', mimeType: '', buffer: Buffer.from('chooser') });
    await chooser.element().dispose();
    const callbacks = [];
    let userConsoleCount = 0;
    const listener = message => {
      userConsoleCount++;
      if (message.text() === 'from user callback') callbacks.push(page.title());
      callbacks.push(...message.args().map(argument => argument.dispose()));
    };
    context.on('console', listener);
    await page.evaluate(() => { console.log('from user callback'); console.log({ hello: 'world' }); console.log(null, undefined, NaN, Infinity, -0); console.log(1n); });
    await Promise.all(callbacks);
    context.off('console', listener);
    assert.equal(userConsoleCount, 4);
    await page.evaluate(() => console.log('trace survives user listener removal'));
    const errorEvent = page.waitForEvent('pageerror');
    await page.evaluate(() => { setTimeout(() => { throw Error('uncaught traced error'); }, 0); });
    const error = await errorEvent;
    assert.ok(error.message.includes('uncaught traced error'));
    const secondPage = await context.newPage();
    await secondPage.close();
    await registration.dispose();
    const path = join(directory, 'actions.zip');
    await context.tracing.stopChunk({ path });
    const inspected = await inspectTrace(path);
    const texts = inspected.events.filter(event => event.type === 'console').map(event => event.text);
    for (const text of ['initial script diagnostic', 'inside evaluate', 'from user callback', '{hello: world}', 'null undefined NaN Infinity 0', 'trace survives user listener removal']) assert.ok(texts.includes(text), `${library}: console ${text}`);
    const bigintText = library === 'playwright' ? 'undefined' : '1';
    assert.ok(texts.includes(bigintText), 'S4.l preserves the declared BigInt console difference');
    outcomes.referenceDifferences = { bigintText };
    const consoleEvent = inspected.events.find(event => event.type === 'console' && event.text === 'inside evaluate');
    const enclosing = inspected.actions.find(action => action.params.expression?.includes?.("inside evaluate"));
    assert.ok(enclosing, `${library}: evaluate expression preview`);
    const after = inspected.events.find(event => event.type === 'after' && event.callId === enclosing.callId);
    assert.ok(inspected.events.indexOf(consoleEvent) < inspected.events.indexOf(after), 'diagnostic drain precedes enclosing completion');
    assert.ok(inspected.events.some(event => event.type === 'event' && event.method === 'pageError' && event.pageId && event.params.error.error.message.includes('uncaught traced error')));
    assert.ok(inspected.events.some(event => event.type === 'event' && event.method === 'pageClosed'));
    assert.equal(inspected.actions.filter(action => action.method === 'title').length, 2, 'ordinary and callback title each recorded once');
    assert.ok(inspected.actions.some(action => action.error?.message.includes('trace browser failure')));
    if (library === 'flashwright') {
      for (const title of ['page.waitForSelector', 'frame.waitForSelector', 'locator.elementHandle', 'locator.evaluate', 'locator.evaluateHandle', 'locator.pressSequentially', 'keyboard.type', 'locator.selectText', 'locator.scrollIntoViewIfNeeded', 'elementhandle.selectText', 'elementhandle.scrollIntoViewIfNeeded', 'page.setInputFiles', 'frame.setInputFiles', 'locator.setInputFiles', 'elementhandle.setInputFiles', 'filechooser.setFiles']) {
        assert.equal(inspected.events.filter(event => event.type === 'before' && event.title === title).length, 1, `${title} records once, without nested delegation`);
      }
      assert.equal(inspected.events.filter(event => event.type === 'before' && event.title === 'jshandle.evaluate').length, 0, 'locator evaluation suppresses its temporary handle delegate');
    }
    outcomes.actions = inspected;

    await context.tracing.startChunk({ title: 'Unfinished operation' });
    const begun = page.waitForEvent('console', message => message.text() === 'pending trace operation');
    const pending = page.evaluate(() => new Promise(resolve => { globalThis.finishTraceOperation = resolve; console.log('pending trace operation'); }));
    await begun;
    const unfinishedPath = join(directory, 'unfinished.zip');
    await context.tracing.stopChunk({ path: unfinishedPath });
    const unfinished = await inspectTrace(unfinishedPath);
    const unfinishedAction = unfinished.actions.find(action => action.params.expression?.includes?.('finishTraceOperation'));
    assert.ok(unfinishedAction);
    assert.ok(!unfinished.events.some(event => event.type === 'after' && event.callId === unfinishedAction.callId));
    await context.tracing.startChunk({ title: 'Next generation' });
    await page.evaluate(() => globalThis.finishTraceOperation(23));
    assert.equal(await pending, 23);
    await page.title();
    const nextPath = join(directory, 'next.zip');
    await context.tracing.stop({ path: nextPath });
    const next = await inspectTrace(nextPath);
    assert.ok(!next.events.some(event => event.callId === unfinishedAction.callId), 'old completion cannot enter new chunk');
    outcomes.unfinished = unfinished;
    outcomes.next = next;
    await context.close();

    const unused = await browser.newContext();
    await unused.close();
    for (const method of ['start', 'startChunk', 'stopChunk', 'stop']) await assert.rejects(unused.tracing[method](), /closed/i);
    outcomes.lazyClosedTracing = true;

    const crashContext = await browser.newContext();
    const crashPage = await crashContext.newPage();
    await crashContext.tracing.start();
    const crashed = crashPage.waitForEvent('crash');
    const crashNavigation = crashPage.goto('chrome://crash', { timeout: 2000 }).then(() => null, error => error);
    await crashed;
    assert.match((await crashNavigation).message, /crash|closed/i);
    const survivingPage = await crashContext.newPage();
    assert.equal(await survivingPage.evaluate(() => 53), 53);
    const crashPath = join(directory, 'crash.zip');
    await crashContext.tracing.stop({ path: crashPath });
    const crashTrace = await inspectTrace(crashPath);
    assert.ok(crashTrace.actions.some(action => action.error?.message.match(/crash|closed/i)));
    outcomes.crash = { sha256: crashTrace.sha256, survivingPageResult: 53 };
    await crashContext.close();

    outcomes.closed = [];
    for (const closure of ['context', 'browser']) {
      const owner = await browser.newContext();
      await owner.tracing.start();
      await owner.newPage();
      await (closure === 'context' ? owner.close() : browser.close());
      for (const [method, options] of [['stopChunk', {}], ['stopChunk', { path: join(directory, `closed-${closure}.zip`) }], ['stop', {}]]) {
        await assert.rejects(owner.tracing[method](options), /closed/i);
        outcomes.closed.push(`${closure}:${method}:${Boolean(options.path)}`);
      }
    }
    return outcomes;
  } finally { await browser.close(); }
}

async function nativeOffAndTransportClosure() {
  const { chromium } = await import('flashwright');
  const browser = await chromium.launch({ executablePath: browserPath });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const client = browser.client;
    const originalRequest = client.request;
    const requests = [];
    client.request = function(method, ...arguments_) { requests.push(method); return originalRequest.call(this, method, ...arguments_); };
    try {
      assert.equal(await page.evaluate(() => 61), 61);
      await page.title();
      assert.equal(context.tracingValue, undefined, 'trace off never allocates a tracing controller');
      assert.deepEqual(requests, ['page.evaluate', 'page.evaluate'], 'trace off sends only the requested browser operations');
    } finally { client.request = originalRequest; }
    await context.tracing.start();
    const temporaryDirectory = context.tracing.chunk.writer.directory;
    const begun = page.waitForEvent('console', message => message.text() === 'waiting for transport closure');
    const pending = page.evaluate(() => new Promise(() => console.log('waiting for transport closure'))).then(() => null, error => error);
    await begun;
    const disconnected = once(browser, 'disconnected');
    client.process.kill('SIGKILL');
    await disconnected;
    const failure = await pending;
    assert.ok(failure instanceof Error);
    await assert.rejects(context.tracing.stop(), { name: 'TargetClosedError' });
    await context.tracing.cleanup;
    await assert.rejects(stat(temporaryDirectory), { code: 'ENOENT' });
    return { traceOffRequests: requests, pendingFailure: failure.name, recordingRemovedAfterTransportClosure: true };
  } finally { await browser.close(); }
}

async function runnerCaptureIsInternal() {
  const { chromium } = await import('flashwright');
  const { ScreenshotLifecycle } = require('../packages/flashwright-runner/dist/commonjs/screenshot-recorder.js');
  const { screenshotPolicy } = require('../packages/flashwright-runner/dist/commonjs/screenshot-policy.js');
  const browser = await chromium.launch({ executablePath: browserPath });
  const lifecycle = new ScreenshotLifecycle(screenshotPolicy('on'));
  const outputDir = join(destination, 'runner-internal');
  await mkdir(outputDir);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.tracing.start();
    await page.evaluate(() => 67);
    const information = { status: 'passed', expectedStatus: 'passed', retry: 0, project: { outputDir }, outputDir, attachments: [], _onDidFinishTestFunctionCallbacks: new Set(), outputPath: name => join(outputDir, name) };
    const recorder = lifecycle.start(information);
    await lifecycle.finish(recorder);
    assert.equal(information.attachments.length, 1);
    assert.equal(information.attachments[0].name, 'screenshot');
    await page.screenshot();
    const path = join(outputDir, 'manual.zip');
    await context.tracing.stop({ path });
    const trace = await inspectTrace(path);
    assert.equal(trace.actions.filter(action => action.method === 'screenshot').length, 1, 'only the explicit user screenshot is a public trace action');
    await context.close();
    return { runnerScreenshotRetained: true, publicScreenshotActions: 1, sha256: trace.sha256 };
  } finally { lifecycle.dispose(); await browser.close(); }
}

async function diagnosticOverflowIsolation() {
  const { chromium } = await import('flashwright');
  const browser = await chromium.launch({ executablePath: browserPath });
  try {
    const affected = await browser.newContext();
    const independent = await browser.newContext();
    const affectedPage = await affected.newPage();
    const independentPage = await independent.newPage();
    await affected.tracing.start();
    await independent.tracing.start();
    const result = await affectedPage.evaluate(() => {
      for (let index = 0; index < 1100; index++) console.log('bounded trace diagnostic', index);
      return 'original browser result';
    });
    assert.equal(result, 'original browser result');
    assert.equal(await independentPage.evaluate(() => 91), 91);
    const preserved = join(destination, 'preserved-on-overflow.zip');
    await writeFile(preserved, 'existing destination');
    await assert.rejects(affected.tracing.stop({ path: preserved }), { name: 'ResourceLimitError' });
    assert.equal(await readFile(preserved, 'utf8'), 'existing destination');
    assert.equal(await affectedPage.evaluate(() => 92), 92);
    const path = join(destination, 'independent.zip');
    await independent.tracing.stop({ path });
    const trace = await inspectTrace(path);
    assert.equal(trace.actions.length, 1);
    await affected.close();
    await independent.close();
    return { originalResult: result, independentResult: 91, affectedStillUsable: 92, exportError: 'ResourceLimitError', destinationPreserved: true, independentTraceSha256: trace.sha256 };
  } finally { await browser.close(); }
}

try {
  for (const library of ['playwright', 'flashwright']) {
    const directory = join(destination, library);
    await mkdir(directory);
    report.outcomes[library] = await exercise(library, directory);
  }
  assert.deepEqual(report.outcomes.flashwright.closed, report.outcomes.playwright.closed);
  report.diagnosticOverflowIsolation = await diagnosticOverflowIsolation();
  report.nativeOffAndTransportClosure = await nativeOffAndTransportClosure();
  report.runnerCaptureIsInternal = await runnerCaptureIsInternal();
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(driverPath)), report.driverSha256);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error;
} finally {
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Manual tracing evidence: ${destination}/report.json`);
}
