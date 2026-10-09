import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from '../packages/flashwright-core/dist/commonjs/index.js';
import { engineHandshake } from '../packages/flashwright-core/dist/commonjs/engine-contract.js';
import { TraceSnapshotChannel } from '../packages/flashwright-core/dist/commonjs/trace-snapshots.js';
import { runTraceInternal } from '../packages/flashwright-core/dist/commonjs/trace-hooks.js';
import { identifyBrowser } from './browser-identity.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';

assert(process.argv[2], 'an unused output directory is required');
assert(process.env.FLASHWRIGHT_BROWSER_PATH, 'an explicit browser executable is required');
assert(process.env.FLASHWRIGHT_DRIVER_PATH, 'an explicit driver executable is required');
const output = resolve(process.argv[2]);
await mkdir(output);
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH;
const driverPath = process.env.FLASHWRIGHT_DRIVER_PATH;
const require = createRequire(import.meta.url);
const { utils } = require('playwright-core/lib/coreBundle');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
engineHandshake.limits.pendingOperations = 2;
const report = {
  status: 'running', ...runtimeMetadata, pendingOperations: 2, cases: [],
  scope: 'Minimum-capacity Chromium tracing and dialog recovery plus controlled native snapshot payload pressure. No performance claim. The pressure case uses explicit native phases and does not claim viewer action-pair conformance.',
};
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const observe = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', name: error.name, message: error.message }));
let browser;

async function compiledManifest() {
  const root = 'packages/flashwright-core/dist/commonjs';
  const files = {};
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files[path] = hash(await readFile(path));
    }
  }
  await visit(root);
  return files;
}

async function inspectArchive(path) {
  execFileSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as archive: assert archive.testzip() is None', path]);
  const archive = new utils.ZipFile(path);
  try {
    const entries = await archive.entries();
    assert(entries.includes('trace.trace'));
    const events = (await archive.read('trace.trace')).toString().trim().split('\n').map(JSON.parse);
    return { entries, events, sha256: hash(await readFile(path)) };
  } finally { archive.close(); }
}

/** Every case owns a fresh context, including when its capture or export fails. */
async function check(name, callback) {
  const result = { name, status: 'running' };
  report.cases.push(result);
  await save();
  let context;
  try {
    context = await browser.newContext();
    assert.equal(context.tracing.client.resourceLimits.pendingOperations, 2);
    await callback(context, result);
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = error.stack ?? String(error); }
  finally {
    if (context) {
      result.cleanup = await observe(context.close());
      if (result.cleanup.status !== 'fulfilled') result.status = 'failed';
    }
    await save();
  }
}

async function traceFlags(context, result, snapshots, screenshots, delivery) {
  result.snapshots = snapshots; result.screenshots = screenshots; result.delivery = delivery;
  const page = await context.newPage();
  await context.tracing.start({ snapshots, screenshots, sources: false });
  result.ordinary = await page.evaluate(() => 42);
  assert.equal(result.ordinary, 42);
  let handling;
  let evaluation;
  if (delivery === 'listener') {
    page.once('dialog', dialog => { handling = observe(dialog.accept()); });
    evaluation = page.evaluate(() => confirm('traced minimum capacity'));
  } else {
    const waiting = (delivery === 'page-waiter' ? page : context).waitForEvent('dialog');
    evaluation = page.evaluate(() => confirm('traced minimum capacity'));
    void evaluation.catch(() => {});
    handling = observe((await waiting).accept());
  }
  result.modal = await evaluation;
  assert.equal(result.modal, true);
  assert(handling, 'original dialog handler was not called');
  result.handling = await handling;
  assert.equal(result.handling.status, 'fulfilled');
  const filename = `trace-${delivery}-${snapshots}-${screenshots}.zip`;
  await context.tracing.stop({ path: join(output, filename) });
  const archive = await inspectArchive(join(output, filename));
  const dialogs = archive.events.filter(event => event.type === 'before' && event.class === 'Dialog');
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].method, 'accept');
  assert.equal(dialogs[0].beforeSnapshot, undefined);
  const completion = archive.events.find(event => event.type === 'after' && event.callId === dialogs[0].callId);
  assert(completion); assert.equal(completion.error, undefined); assert.equal(completion.afterSnapshot, undefined);
  const waiters = archive.events.filter(event => event.type === 'before' && event.method === 'waitForEvent');
  assert.equal(waiters.length, delivery === 'listener' ? 0 : 1);
  for (const waiter of waiters) {
    assert.equal(waiter.class, delivery === 'page-waiter' ? 'Page' : 'BrowserContext');
    assert.equal(waiter.params.event, 'dialog'); assert.equal(waiter.beforeSnapshot, undefined);
    const delivered = archive.events.find(event => event.type === 'after' && event.callId === waiter.callId);
    assert(delivered); assert.equal(delivered.error, undefined); assert.equal(delivered.afterSnapshot, undefined);
  }
  const snapshotCount = archive.events.filter(event => event.type === 'frame-snapshot').length;
  assert(snapshots ? snapshotCount > 0 : snapshotCount === 0);
  result.archive = { path: filename, sha256: archive.sha256, entries: archive.entries.length, snapshots: snapshotCount, dialogCalls: dialogs.length };
}

/** Event delivery must unblock handling; subscription setup and final removal use public APIs. */
async function consoleRecovery(context, result, ownerKind, tracingOptions) {
  const page = await context.newPage();
  const owner = ownerKind === 'page' ? page : context;
  result.owner = ownerKind; result.tracingOptions = tracingOptions;
  if (tracingOptions) await context.tracing.start({ ...tracingOptions, sources: false });
  let resolveDialog;
  const observedDialog = new Promise(resolve => { resolveDialog = resolve; });
  page.once('dialog', dialog => resolveDialog(dialog));
  const waiting = owner.waitForEvent('console');
  const evaluation = observe(page.evaluate(() => { console.log('ready for recovery'); return confirm('console event recovery'); }));
  const message = await waiting;
  assert.equal(message.text(), 'ready for recovery');
  const dialog = await observedDialog;
  assert.equal(dialog.message(), 'console event recovery');
  assert.equal(owner.listenerCount('console'), 0);
  await dialog.accept();
  result.evaluation = await evaluation;
  assert.equal(result.evaluation.status, 'fulfilled'); assert.equal(result.evaluation.value, true);
  assert.equal(await page.evaluate(() => 42), 42);
  if (tracingOptions) {
    const filename = `console-${ownerKind}-${tracingOptions.snapshots}-${tracingOptions.screenshots}.zip`;
    await context.tracing.stop({ path: join(output, filename) });
    const archive = await inspectArchive(join(output, filename));
    const waiter = archive.events.find(event => event.type === 'before' && event.method === 'waitForEvent');
    assert(waiter); assert.equal(waiter.params.event, 'console');
    const completion = archive.events.find(event => event.type === 'after' && event.callId === waiter.callId);
    assert(completion); assert.equal(completion.error, undefined);
    assert.equal(Boolean(waiter.beforeSnapshot), tracingOptions.snapshots);
    assert.equal(Boolean(completion.afterSnapshot), tracingOptions.snapshots);
    result.archive = { path: filename, sha256: archive.sha256, entries: archive.entries.length };
  }
}

/** Hold two real committed payloads; resume ingestion only after the next capture owns its command. */
async function payloadPressure(context, result) {
  const originalSchedule = TraceSnapshotChannel.prototype.schedule;
  let collectorPaused = true;
  TraceSnapshotChannel.prototype.schedule = function () { if (!collectorPaused) return originalSchedule.call(this); };
  result.scope = 'Only the snapshot collector timer is paused. Untraced DOM preparation plus explicit native after phases avoids extra automatic captures. Payload and operation limits are unchanged.';
  const payloadTextBytes = 2304 * 1024;
  try {
    const page = await context.newPage();
    await page.evaluate(() => { document.body.replaceChildren(document.createElement('div')); });
    await context.tracing.start({ snapshots: true, screenshots: false, sources: false });
    const channel = context.tracing.chunk.snapshots;
    assert(channel instanceof TraceSnapshotChannel);
    const client = channel.client;
    const parameters = call => ({ ...channel.identity, call, page: page.identifier });
    for (const character of ['a', 'b']) {
      const size = await runTraceInternal(() => page.evaluate(({ character, size }) => {
        document.body.firstElementChild.textContent = character.repeat(size);
        return document.body.firstElementChild.textContent.length;
      }, { character, size: payloadTextBytes }));
      assert.equal(size, payloadTextBytes);
      await client.request('context.trace.snapshot.after', parameters(`pressure-${character}`), 2000);
    }
    const batch = await client.request('context.trace.snapshot.pull', channel.identity, 2000);
    assert.deepEqual(batch.snapshots.map(metadata => [metadata.call, metadata.phase]), [['pressure-a', 'after'], ['pressure-b', 'after']]);
    channel.acceptMetadata(batch);
    result.retainedSnapshots = batch.snapshots;
    result.retainedDataBytes = batch.snapshots.reduce((sum, metadata) => sum + metadata.byteLength, 0);
    assert(result.retainedDataBytes > 4 * 1024 * 1024 && result.retainedDataBytes < 8 * 1024 * 1024);
    assert(batch.snapshots.every(metadata => metadata.byteLength <= 4 * 1024 * 1024 - 64 * 1024));
    result.ordinary = await runTraceInternal(() => page.evaluate(() => { document.body.firstElementChild.textContent = 'third capture'; return 42; }));
    assert.equal(result.ordinary, 42);
    const captureStarted = performance.now();
    const captured = observe(client.request('context.trace.snapshot.after', parameters('pressure-third'), 2000));
    const admissionDeadline = captureStarted + 1500;
    while (![...client.pending.values()].some(request => request.method === 'context.trace.snapshot.after')) {
      assert(performance.now() < admissionDeadline, 'third capture did not acquire pending custody');
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    result.pendingAtResume = [...client.pending.values()].map(request => request.method);
    collectorPaused = false;
    channel.schedule();
    result.capture = await captured;
    result.captureElapsedMilliseconds = performance.now() - captureStarted;
    assert.equal(result.capture.status, 'fulfilled', JSON.stringify(result.capture));
    assert.equal(context.tracing.chunk.writer.failure, undefined);
    const filename = 'trace-payload-pressure.zip';
    await context.tracing.stop({ path: join(output, filename) });
    const archive = await inspectArchive(join(output, filename));
    const snapshots = archive.events.filter(event => event.type === 'frame-snapshot');
    assert.equal(snapshots.length, 3);
    assert.deepEqual(snapshots.map(event => event.snapshot.callId), ['pressure-a', 'pressure-b', 'pressure-third']);
    result.archive = { path: filename, sha256: archive.sha256, entries: archive.entries.length, snapshots: snapshots.length };
  } finally { collectorPaused = false; TraceSnapshotChannel.prototype.schedule = originalSchedule; }
}

try {
  report.sources = await sourceManifest();
  report.compiled = await compiledManifest();
  report.browser = await identifyBrowser(browserPath);
  report.driverSha256 = hash(await readFile(driverPath));
  await save();
  browser = await chromium.launch({ executablePath: browserPath });
  for (const delivery of ['listener', 'page-waiter', 'context-waiter']) for (const snapshots of [false, true]) for (const screenshots of [false, true]) {
    await check(`${delivery},snapshots=${snapshots},screenshots=${screenshots}`, (context, result) => traceFlags(context, result, snapshots, screenshots, delivery));
  }
  for (const owner of ['page', 'context']) {
    await check(`${owner} console recovery without tracing`, (context, result) => consoleRecovery(context, result, owner));
    for (const snapshots of [false, true]) for (const screenshots of [false, true]) {
      await check(`${owner} console recovery snapshots=${snapshots},screenshots=${screenshots}`, (context, result) => consoleRecovery(context, result, owner, { snapshots, screenshots }));
    }
  }
  await check('retained snapshot payload pressure', payloadPressure);
  assert.equal(report.cases.length, 23);
  assert(report.cases.every(result => result.status === 'passed'), 'one or more trace pressure cases failed');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); }
finally {
  if (browser) {
    report.cleanup = await observe(browser.close());
    if (report.cleanup.status !== 'fulfilled') report.status = 'failed';
  }
  try {
    if (report.sources) assert.deepEqual(await sourceManifest(), report.sources);
    if (report.compiled) assert.deepEqual(await compiledManifest(), report.compiled);
    if (report.browser) assert.deepEqual(await identifyBrowser(browserPath), report.browser);
    if (report.driverSha256) assert.equal(hash(await readFile(driverPath)), report.driverSha256);
    report.identitiesUnchanged = true;
  } catch (error) { report.status = 'failed'; report.identityError = error.stack ?? String(error); }
  await save();
  console.log(JSON.stringify({ status: report.status, cases: report.cases.map(({ name, status }) => ({ name, status })), error: report.error, identityError: report.identityError }));
  if (report.status !== 'passed') process.exitCode = 1;
}
