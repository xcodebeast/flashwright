import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const { chromium } = require('../packages/flashwright-core/dist/commonjs/index.js');
const { instrumentTraceMethods, traceChunkOpened, traceChunkClosed } = require('../packages/flashwright-core/dist/commonjs/trace-hooks.js');
const { iso } = require('playwright-core/lib/coreBundle');
const checks = [];
const details = [];
const report = { status: 'running', scope: 'Private native snapshot phases and real browser worker, not public snapshots or offline network acceptance', checks, details };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let browser;
let sequence = 0;
class TracedAction {
  constructor(context, page, identity) { this.context = context; this.page = page; this.identity = identity; }
  run(callback) { return callback(); }
  get tracing() {
    return {
      begin: () => ({ nativeTrace: { context: this.context.identifier, generation: this.identity.chunk, recording: this.identity.recording, call: `call-${++sequence}` } }),
      complete: async call => this.context.client.request('context.trace.snapshot.after', { context: this.context.identifier, recording: call.nativeTrace.recording, chunk: call.nativeTrace.generation, call: call.nativeTrace.call, page: this.page.identifier }, 3000),
      completeSynchronously: () => {},
    };
  }
}
instrumentTraceMethods(TracedAction.prototype, 'NativeSnapshotProbe', owner => owner, { run: {} });
async function check(name, callback) { await callback(); checks.push(name); }
async function fixture() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('data:text/html,' + encodeURIComponent('<!doctype html><body><button id="button" onclick="this.textContent=\'clicked\'">before</button><input id="input"><select id="select"><option value="one">One</option><option value="two">Two</option></select><iframe srcdoc="<!doctype html><body><p>child-original</p>"></iframe></body>'));
  const child = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
  assert.ok(child);
  await child.locator('p').waitFor();
  const identity = { context: context.identifier, recording: `recording-${++sequence}`, chunk: `chunk-${sequence}` };
  const client = context.client;
  await client.request('context.trace.recording.start', { context: identity.context, recording: identity.recording }, 3000);
  await client.request('context.trace.chunk.start', identity, 3000);
  const action = new TracedAction(context, page, identity);
  const storage = new iso.SnapshotStorage();
  const received = [];
  const pull = () => client.request('context.trace.snapshot.pull', identity, 3000);
  async function consume(metadata, ingest = true) {
    const parameters = { ...identity, capture: metadata.capture };
    const bytes = await client.requestTraceAttachment('context.trace.snapshot.take', parameters, 3000, metadata.byteLength);
    assert.equal(bytes.length, metadata.byteLength);
    const data = JSON.parse(bytes.toString('utf8'));
    assert.equal(typeof data.url, 'string');
    const snapshot = { ...data, frameUrl: data.url, frameId: metadata.frame, pageId: metadata.page, callId: metadata.call,
      snapshotName: `${metadata.phase}@${metadata.call}`, timestamp: metadata.nativeTime, isMainFrame: metadata.isMainFrame };
    assert.equal(data.resourceOverrides.length, 0, 'fixture must not need external CSS resource ingestion');
    delete snapshot.url;
    const rendered = storage.addFrameSnapshot(identity.context, snapshot, []).render().html;
    received.push({ metadata, data, rendered });
    if (ingest) await client.request('context.trace.snapshot.ingested', { ...parameters, success: true }, 3000);
    return received.at(-1);
  }
  async function collect() { const reply = await pull(); for (const metadata of reply.snapshots) await consume(metadata); return reply; }
  return { context, page, client, identity, action, received, consume, collect, pull, async dispose() { await context.close(); } };
}
try {
  browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  await check('native Before/Input/After capture all original frames and retain pointer target identity', async () => {
    const state = await fixture();
    traceChunkOpened();
    try {
      await state.action.run(() => state.page.locator('#button').click());
      await state.collect();
      assert.deepEqual(state.received.map(entry => entry.metadata.phase), ['before', 'before', 'input', 'input', 'after', 'after']);
      const parent = state.received.filter(entry => entry.metadata.isMainFrame);
      assert.equal(parent.length, 3);
      assert.ok(parent[0].rendered.includes('>before</BUTTON>'));
      assert.ok(parent[1].rendered.includes('__playwright_target__'));
      assert.ok(parent[2].rendered.includes('>clicked</BUTTON>'));
      const child = state.received.find(entry => !entry.metadata.isMainFrame);
      assert.ok(parent[0].rendered.includes(`/snapshot/${child.metadata.frame}`));
      assert.ok(child.rendered.includes('child-original'));
      assert.deepEqual(parent.map(entry => entry.metadata.snapshotNumber), [1, 2, 3]);
      details.push({ name: 'pointer', captures: state.received.map(entry => entry.metadata) });
    } finally { traceChunkClosed(); await state.dispose(); }
  });
  await check('traced fill and select retain targets and show the final form state', async () => {
    const state = await fixture();
    traceChunkOpened();
    try {
      await state.action.run(() => state.page.locator('#input').fill('changed'));
      await state.collect();
      await state.action.run(() => state.page.locator('#select').selectOption('two'));
      await state.collect();
      const parents = state.received.filter(entry => entry.metadata.isMainFrame);
      assert.deepEqual(parents.map(entry => entry.metadata.phase), ['before', 'input', 'after', 'before', 'input', 'after']);
      assert.ok(parents[1].rendered.includes('__playwright_target__'));
      assert.ok(parents[2].rendered.includes('__playwright_value_="changed"'));
      assert.ok(parents[4].rendered.includes('__playwright_target__'));
      assert.match(parents[5].rendered, /<OPTION[^>]*__playwright_selected_="true"[^>]*>Two/);
      assert.equal(await state.page.locator('#input').inputValue(), 'changed');
      assert.equal(await state.page.locator('#select').inputValue(), 'two');
      details.push({ name: 'mutations', captures: state.received.map(entry => entry.metadata) });
    } finally { traceChunkClosed(); await state.dispose(); }
  });
  await check('sealed chunk waits for original byte ingestion and worker retirement before its successor', async () => {
    const state = await fixture();
    try {
      await state.client.request('context.trace.snapshot.after', { ...state.identity, page: state.page.identifier, call: 'original-call' }, 3000);
      const original = await state.pull();
      assert.equal(original.snapshots.length, 2);
      await state.consume(original.snapshots[0], false);
      await state.client.request('context.trace.chunk.seal', state.identity, 3000);
      await assert.rejects(state.client.request('context.trace.chunk.start', { ...state.identity, chunk: 'successor' }, 3000), { name: 'InvalidArgumentError' });
      await state.client.request('context.trace.snapshot.after', { ...state.identity, page: state.page.identifier, call: 'late-original-call' }, 3000);
      assert.deepEqual((await state.pull()).snapshots, []);
      for (const [index, metadata] of original.snapshots.entries()) {
        if (index > 0) await state.consume(metadata, false);
        await assert.rejects(state.client.requestTraceAttachment('context.trace.snapshot.take', { ...state.identity, capture: metadata.capture }, 3000, metadata.byteLength));
        await state.client.request('context.trace.snapshot.ingested', { ...state.identity, capture: metadata.capture, success: true }, 3000);
      }
      const deadline = performance.now() + 3000;
      while ((await state.pull()).pending) { assert.ok(performance.now() < deadline, 'original workers must retire'); await pause(10); }
      await state.client.request('context.trace.chunk.start', { ...state.identity, chunk: 'successor' }, 3000);
      await state.client.request('context.trace.chunk.seal', { ...state.identity, chunk: 'successor' }, 3000);
      await state.client.request('context.trace.recording.stop', { context: state.identity.context, recording: state.identity.recording }, 3000);
      assert.equal(await state.page.evaluate(() => 42), 42);
    } finally { await state.dispose(); }
  });
  await check('host ingestion failure poisons only its recording and preserves ordinary page work', async () => {
    const state = await fixture();
    try {
      await state.client.request('context.trace.snapshot.after', { ...state.identity, page: state.page.identifier, call: 'failed-ingestion' }, 3000);
      const reply = await state.pull();
      const metadata = reply.snapshots[0];
      await state.consume(metadata, false);
      await state.client.request('context.trace.snapshot.ingested', { ...state.identity, capture: metadata.capture, success: false, message: 'controlled host writer failure' }, 3000);
      await assert.rejects(state.pull(), /controlled host writer failure/);
      assert.equal(await state.page.evaluate(() => 43), 43);
    } finally { await state.dispose(); }
  });
  await check('snapshot resource failure preserves successful mutation and the original rejected public outcome', async () => {
    const state = await fixture();
    await state.page.evaluate(() => {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 25001; index++) fragment.appendChild(document.createTextNode('x'));
      document.body.appendChild(fragment);
    });
    traceChunkOpened();
    try {
      await state.action.run(() => state.page.locator('#input').fill('action-survived'));
      assert.equal(await state.page.locator('#input').inputValue(), 'action-survived');
      await assert.rejects(state.pull(), { name: 'ResourceLimitError' });
      await assert.rejects(state.action.run(() => state.page.evaluate(() => { throw new Error('original public failure'); })), /original public failure/);
      assert.equal(await state.page.evaluate(() => 44), 44);
    } finally { traceChunkClosed(); await state.dispose(); }
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { await browser?.close(); if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
