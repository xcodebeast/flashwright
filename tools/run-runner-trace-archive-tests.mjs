import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'flashwright';
import { chromium as referenceChromium } from 'playwright';
import { identifyBrowser } from './browser-identity.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';

const require = createRequire(resolve('packages/flashwright-core/package.json'));
const { runnerIntegration } = require('@flashwright/core/runner-integration');
const { EngineClient } = require(resolve('packages/flashwright-core/dist/commonjs/client.js'));
const { iso, utils } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath();
const driverPath = process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver');
process.env.FLASHWRIGHT_DRIVER_PATH = driverPath;
const destination = resolve(process.env.FLASHWRIGHT_HANDOFF_OUTPUT ?? `compatibility/evidence/runner-trace-handoff-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(destination, { recursive: true });
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(), browser: await identifyBrowser(browserPath), driverSha256: hash(await readFile(driverPath)), archives: [], checks: [] };
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url.startsWith('/payload')) {
    response.setHeader('Content-Type', 'text/plain');
    response.end(`original resource ${new URL(request.url, 'http://fixture').searchParams.get('marker')}`);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Runner handoff</title><input id="value"><div id="marker">initial</div>');
  }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const retained = [];
const assembly = runnerIntegration.createTraceArchiveAssembly(4);
const admitted = new Set();
let combined;
const handles = new Map();
const recordings = new Map();
const creationClaims = [];
let attempt = 'original attempt';
let browser;
let registration;

async function capture(context, marker) {
  const page = context.pages()[0] ?? await context.newPage();
  if (page.url() === 'about:blank') await page.goto(origin);
  await page.locator('#value').fill(marker);
  assert.equal(await page.evaluate(async value => {
    document.querySelector('#marker').textContent = value;
    console.log(value);
    const response = await (await fetch(`/payload?marker=${value}`)).text();
    // Animation callbacks precede presentation; two callbacks can finish before
    // Chromium emits its first screencast frame. Exercise visible paint across
    // a finite real interval, then independently require the archived frame.
    const marker = document.querySelector('#marker');
    const originalColor = marker.style.color;
    await new Promise(resolve => {
      let started;
      let sequence = 0;
      const paint = () => {
        const now = performance.now();
        started ??= now;
        marker.style.color = sequence++ % 2 ? 'rgb(180, 0, 0)' : 'rgb(0, 0, 180)';
        if (now - started < 350) requestAnimationFrame(paint);
        else {
          marker.style.color = originalColor;
          requestAnimationFrame(() => setTimeout(resolve, 0));
        }
      };
      requestAnimationFrame(paint);
    });
    return response;
  }, marker), `original resource ${marker}`);
}

async function retain(context, marker) {
  const handle = handles.get(context);
  assert.ok(handle);
  const archive = await handle.takeArchive();
  handles.delete(context);
  retained.push({ marker, archive });
}

try {
  browser = await chromium.launch({ executablePath: browserPath });
  const surviving = await browser.newContext();
  const closedMarkers = new Map();
  registration = runnerIntegration.installOwnedContextLifecycle(8, {
    beginContextCreation() {
      const claim = { owner: attempt, enrolled: undefined, completions: 0 };
      creationClaims.push(claim);
      return {
        async didCreateContext(context) {
          claim.enrolled = claim.owner;
          const recording = await runnerIntegration.startTraceRecording(7, context.tracing, { screenshots: true, snapshots: true, sources: true, title: claim.owner });
          assert.equal(runnerIntegration.currentTraceRecording(7, context.tracing), recording);
          recordings.set(context, recording);
          const handle = runnerIntegration.currentTraceChunk(3, context.tracing);
          assert.ok(handle); handles.set(context, handle);
        },
        complete() { claim.completions++; },
      };
    },
    async willCloseContext(context) {
      if (handles.has(context)) await retain(context, closedMarkers.get(context));
      await recordings.get(context)?.stop();
      recordings.delete(context);
    },
  });
  await registration.ready;
  // Delay delivery of a real native allocation, crossing an attempt boundary while
  // keeping the same worker observer installed. The native result is never replaced.
  const originalRequest = EngineClient.prototype.request;
  let allocationReturned; const allocated = new Promise(resolve => { allocationReturned = resolve; });
  let releaseReply; const replyGate = new Promise(resolve => { releaseReply = resolve; });
  let delayedCreation;
  try {
    EngineClient.prototype.request = async function(method, ...arguments_) {
      const result = await originalRequest.call(this, method, ...arguments_);
      if (method === 'browser.newContext') { allocationReturned(); await replyGate; }
      return result;
    };
    delayedCreation = browser.newContext();
    const claim = creationClaims.at(-1);
    assert.equal(claim.owner, 'original attempt');
    await allocated; attempt = 'successor attempt';
    assert.equal(claim.enrolled, undefined); assert.equal(claim.completions, 0);
    releaseReply(); const late = await delayedCreation;
    assert.equal(claim.enrolled, 'original attempt'); assert.equal(claim.completions, 1);
    await handles.get(late).discard(); handles.delete(late); await late.close();
    report.checks.push('a delayed real native allocation retains its original attempt claim while the worker advances');
  } finally {
    releaseReply(); EngineClient.prototype.request = originalRequest;
    await delayedCreation?.catch(() => {});
  }
  attempt = 'original attempt';
  await capture(surviving, 'surviving-first');
  const original = handles.get(surviving);
  await retain(surviving, 'surviving-first');
  const successor = await recordings.get(surviving).startChunk({ title: 'Successor chunk' });
  handles.set(surviving, successor);
  await assert.rejects(original.takeArchive(), /original trace chunk is no longer current/);
  await assert.rejects(original.discard(), /original trace chunk is no longer current/);
  assert.equal(runnerIntegration.currentTraceChunk(3, surviving.tracing), successor);
  report.checks.push('existing context adoption and original handle rejection preserve the successor');

  const early = await browser.newContext();
  await capture(early, 'early-close');
  closedMarkers.set(early, 'early-close');
  await early.close();
  const discarded = await browser.newContext();
  await capture(discarded, 'discarded');
  await handles.get(discarded).discard();
  handles.delete(discarded);
  assert.equal(runnerIntegration.currentTraceChunk(3, discarded.tracing), undefined);
  await discarded.close();
  report.checks.push('exact discard retires native snapshot, network and filmstrip collectors without an archive');
  await capture(surviving, 'surviving-second');
  closedMarkers.set(surviving, 'surviving-second');
  await surviving.close();
  await registration.dispose(); registration = undefined;
  await browser.close(); browser = undefined;
  assert.equal(handles.size, 0);
  assert.equal(recordings.size, 0);
  assert.equal(retained.length, 3);
  assert.equal(creationClaims.length, 4);
  assert.ok(creationClaims.every(claim => claim.completions === 1 && claim.enrolled === claim.owner));
  report.creationClaims = creationClaims;
  report.checks.push('explicit closure seals the original chunks before native contexts and browser retire');

  for (const { marker, archive } of retained) {
    const path = join(destination, `${marker}.zip`);
    await archive.export(path, new AbortController().signal);
    const zip = new utils.ZipFile(path);
    try {
      const names = await zip.entries();
      const loader = new iso.TraceLoader();
      await loader.load({ entryNames: async () => names, readText: async name => names.includes(name) ? (await zip.read(name)).toString() : undefined, hasEntry: async name => names.includes(name), isLive: () => false });
      assert.equal(loader.contextEntries.length, 1);
      const records = (await zip.read('trace.trace')).toString().trim().split('\n').map(JSON.parse);
      assert.deepEqual(records.filter(record => record.type === 'console').map(record => record.text), [marker]);
      assert.ok(records.some(record => record.type === 'frame-snapshot'));
      assert.ok(records.some(record => record.type === 'screencast-frame'));
      assert.ok(names.some(name => name.startsWith('resources/src@')));
      const entries = (await zip.read('trace.network')).toString().trim().split('\n').filter(Boolean).map(JSON.parse);
      const responses = entries.filter(entry => entry.snapshot.request.url.includes(`/payload?marker=${marker}`));
      assert.equal(responses.length, 1);
      const resourceName = responses[0].snapshot.response.content._sha1;
      assert.equal((await zip.read(`resources/${resourceName}`)).toString(), `original resource ${marker}`);
      report.archives.push({ marker, path, sha256: hash(await readFile(path)), entries: names.length, snapshots: records.filter(record => record.type === 'frame-snapshot').length, filmstripFrames: records.filter(record => record.type === 'screencast-frame').length, actions: loader.contextEntries[0].actions.length, responseResource: resourceName });
    } finally { zip.close(); }
  }
  for (const { archive } of retained) { assembly.addLibrary(archive); admitted.add(archive); }
  combined = assembly.seal();
  await assembly.dispose();
  const combinedPath = join(destination, 'combined.zip');
  await combined.export(combinedPath, new AbortController().signal);
  const combinedZip = new utils.ZipFile(combinedPath);
  try {
    const names = await combinedZip.entries();
    const loader = new iso.TraceLoader();
    await loader.load({ entryNames: async () => names, readText: async name => names.includes(name) ? (await combinedZip.read(name)).toString() : undefined, hasEntry: async name => names.includes(name), isLive: () => false });
    assert.equal(loader.contextEntries.length, 3);
    for (const [index, { marker }] of retained.entries()) {
      const records = (await combinedZip.read(`${index}-trace.trace`)).toString().trim().split('\n').map(JSON.parse);
      assert.deepEqual(records.filter(record => record.type === 'console').map(record => record.text), [marker]);
      const bodyName = report.archives[index].responseResource;
      assert.equal((await combinedZip.read(`resources/${bodyName}`)).toString(), `original resource ${marker}`);
    }
    report.combined = { path: combinedPath, sha256: hash(await readFile(combinedPath)), entries: names.length, contexts: loader.contextEntries.length };
  } finally { combinedZip.close(); }
  execFileSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as archive: assert archive.testzip() is None', combinedPath]);
  report.checks.push('one composite ZIP reads the original leased files and preserves all three chunk identities after browser closure');
  execFileSync('python3', ['-c', 'import sys,zipfile\nfor path in sys.argv[1:]:\n with zipfile.ZipFile(path) as archive: assert archive.testzip() is None, path', ...report.archives.map(archive => archive.path)]);
  report.checks.push('all retained archives export after closure with independent ZIP CRC, pinned loader, source, snapshot, filmstrip and original response checks');
  assert.deepEqual(await sourceManifest(), report.sources);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
finally {
  const cleanup = [];
  cleanup.push(...await Promise.allSettled([registration?.dispose()]));
  cleanup.push(...await Promise.allSettled([browser?.close()]));
  cleanup.push(...await Promise.allSettled([combined?.dispose(), assembly.dispose()]));
  cleanup.push(...await Promise.allSettled(retained.filter(({ archive }) => !admitted.has(archive)).map(({ archive }) => archive.dispose())));
  server.closeAllConnections();
  cleanup.push(...await Promise.allSettled([new Promise(resolve => server.close(resolve))]));
  const failures = cleanup.filter(result => result.status === 'rejected');
  report.cleanupFailures = failures.map(result => ({ name: result.reason?.name, message: String(result.reason) }));
  const cleanupFailedAfterSuccess = report.status === 'passed' && failures.length > 0;
  if (cleanupFailedAfterSuccess) report.status = 'failed';
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Runner trace handoff evidence: ${destination}/report.json`);
  if (cleanupFailedAfterSuccess) throw failures[0].reason;
}
