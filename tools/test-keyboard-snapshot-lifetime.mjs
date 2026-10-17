import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { chromium } = require('../packages/flashwright-core/dist/commonjs/index.js');
const { instrumentTraceMethods, traceChunkOpened, traceChunkClosed } = require('../packages/flashwright-core/dist/commonjs/trace-hooks.js');
const { iso, utils } = require('playwright-core/lib/coreBundle');
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: false });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
process.env.FLASHWRIGHT_KEYBOARD_SNAPSHOT_DIRECTORY = output;
process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY = join(output, 'protocol');
process.env.FLASHWRIGHT_PROFILE_BROWSER_PATH = process.env.FLASHWRIGHT_BROWSER_PATH;
process.env.FLASHWRIGHT_PROFILE_CLOCK_PORT = '0';
const report = { status: 'running', scope: 'Candidate-only genuine browser reply gates and native terminal outcomes; no performance or reference scheduling claim.', checks: [],
  browserSha256: hash(await readFile(process.env.FLASHWRIGHT_BROWSER_PATH)), driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)),
  sourceSha256: hash(await readFile(new URL(import.meta.url))), proxySha256: hash(await readFile('tools/keyboard-snapshot-proxy.py')) };
async function until(predicate, message) {
  const start = performance.now();
  while (!(await predicate())) { assert.ok(performance.now() - start < 5000, message); await pause(5); }
}
async function held(label) {
  let record;
  await until(async () => {
    try { record = JSON.parse(await readFile(join(output, `held-${label}.json`), 'utf8')); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
  }, `No held native ${label} reply`);
  return record;
}
const release = label => writeFile(join(output, `release-${label}`), 'release\n');
async function control(label, mode) {
  const pending = join(output, 'control.pending');
  await writeFile(pending, JSON.stringify({ label, mode }));
  await rename(pending, join(output, 'control.json'));
}
class NativeCall {
  constructor(context, identity) { this.context = context; this.identity = identity; }
  run(callback) { return callback(); }
  get tracing() { return { begin: () => ({ nativeTrace: this.identity }), complete: async () => {}, completeSynchronously: () => {} }; }
}
instrumentTraceMethods(NativeCall.prototype, 'NativeKeyboardControl', owner => owner, { run: {} });
let browser;
try {
  browser = await chromium.launch({ executablePath: resolve('tools/keyboard-snapshot-proxy.py') });
  {
    const context = await browser.newContext(); const page = await context.newPage();
    await page.goto('data:text/html,' + encodeURIComponent('<input id="input"><p id="state">state:</p><script>input.oninput=()=>document.querySelector("#state").textContent="state:"+input.value;</script>'));
    await page.locator('#input').focus();
    await context.tracing.start({ snapshots: true });
    await control('key', 'key');
    let typingDone = false, pressDone = false;
    const typing = page.keyboard.type('xy').finally(() => { typingDone = true; }); void typing.catch(() => {});
    const nativeHeld = await held('key');
    const press = page.keyboard.press('Backspace').finally(() => { pressDone = true; }); void press.catch(() => {});
    await until(() => [...page.client.pending.values()].some(request => request.method === 'keyboard.press' && request.dispatched), 'Queued press was not dispatched to the original driver');
    await pause(100);
    assert.equal(typingDone, false, 'Genuine key acknowledgement still owns typing');
    assert.equal(pressDone, false, 'Second input waits for the original lock');
    await release('key'); await Promise.all([typing, press]);
    const path = join(output, 'queued.zip'); await context.tracing.stop({ path });
    const archive = new utils.ZipFile(path);
    try {
      const events = (await archive.read('trace.trace')).toString().trim().split('\n').map(JSON.parse);
      const calls = events.filter(event => event.type === 'before' && ['keyboardType', 'keyboardPress'].includes(event.method));
      assert.deepEqual(calls.map(call => call.method), ['keyboardType', 'keyboardPress']);
      assert.ok(calls.every(call => !call.beforeSnapshot));
      const storage = new iso.SnapshotStorage(); const states = new Map();
      for (const { snapshot } of events.filter(event => event.type === 'frame-snapshot')) {
        assert.ok(!states.has(snapshot.snapshotName), 'No duplicate phase');
        states.set(snapshot.snapshotName, storage.addFrameSnapshot('context', snapshot, []).render().html.match(/<p\b[^>]*\bid="state"[^>]*>([^<]*)<\/p>/i)?.[1]);
      }
      for (const [index, before, after] of [[0, '', 'xy'], [1, 'xy', 'x']]) {
        assert.equal(states.get(`input@${calls[index].callId}`), `state:${before}`);
        assert.equal(states.get(`after@${calls[index].callId}`), `state:${after}`);
      }
      assert.equal(states.size, 4);
    } finally { archive.close(); }
    assert.equal(await page.locator('#input').inputValue(), 'x');
    report.checks.push({ name: 'genuine key acknowledgement holds lock before queued input capture', nativeHeld, archiveSha256: hash(await readFile(path)) });
    await context.close();
  }
  {
    const context = await browser.newContext(); const page = await context.newPage();
    await page.goto('data:text/html,<title>healthy</title><input>');
    const client = context.client;
    const identity = { context: context.identifier, recording: 'empty-type-recording', generation: 'empty-type-chunk', call: 'empty-type-call' };
    await client.request('context.trace.recording.start', { context: identity.context, recording: identity.recording }, 3000);
    await client.request('context.trace.chunk.start', { context: identity.context, recording: identity.recording, chunk: identity.generation }, 3000);
    const nativeReplies = [];
    let buffered = Buffer.alloc(0);
    const observe = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      assert.ok(buffered.length < 1024 * 1024, 'Bound control-only native observer');
      while (buffered.length >= 4 && buffered.length >= buffered.readUInt32LE(0) + 4) {
        const length = buffered.readUInt32LE(0);
        const reply = JSON.parse(buffered.subarray(4, length + 4).toString()); buffered = buffered.subarray(length + 4);
        if (client.pending.get(reply.requestId)?.method === 'keyboard.type') nativeReplies.push(reply);
      }
    };
    client.process.stdout.prependListener('data', observe);
    await control('capture', 'capture');
    traceChunkOpened();
    try {
      const call = new NativeCall(context, identity);
      const empty = call.run(() => client.request('keyboard.type', { page: page.identifier, textUnits: [] }, 500));
      void empty.catch(() => {});
      const nativeHeld = await held('capture');
      const outcome = await empty.then(() => ({ status: 'fulfilled' }), error => ({ status: 'rejected', name: error.name }));
      report.checks.push({ name: 'empty typing preserves original native cancellation during input capture', nativeHeld, outcome, nativeReplies });
      assert.deepEqual(outcome, { status: 'rejected', name: 'TimeoutError' });
      await until(() => nativeReplies.length > 0, 'No original native typing terminal reply');
      assert.equal(nativeReplies.length, 1);
      assert.equal(nativeReplies[0].kind, 'error', 'Native empty typing must reject; host timeout masking a native success is insufficient');
      assert.ok(['TimeoutError', 'CancelledError'].includes(nativeReplies[0].error.code), JSON.stringify(nativeReplies[0]));
      assert.equal(nativeReplies[0].error.inputDelivery, 'notDispatched');
    } finally {
      traceChunkClosed(); client.process.stdout.off('data', observe); await release('capture');
    }
    assert.equal(await page.title(), 'healthy', 'Optional capture cancellation keeps the page healthy');
    await context.close();
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  await release('key'); await release('capture'); await browser?.close();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report));
}
