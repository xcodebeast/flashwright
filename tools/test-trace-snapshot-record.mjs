import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const require = createRequire(import.meta.url);
const { prepareSnapshotRecord, maximumSnapshotRecordBytes } = require('../packages/flashwright-core/dist/commonjs/trace-snapshot-record.js');
const { TraceResources } = require('../packages/flashwright-core/dist/commonjs/trace-resources.js');
const { TraceWriter } = require('../packages/flashwright-core/dist/commonjs/trace-writer.js');
const output = resolve(process.argv[2]);
await mkdir(output);
const report = { status: 'running', checks: [] };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = (text = '') => ({ type: 'frame-snapshot', snapshot: { callId: 'call', snapshotName: 'before@call', pageId: 'page', frameId: 'frame', frameUrl: 'about:blank', doctype: 'html', html: ['DIV', {}, text], viewport: { width: 800, height: 600 }, timestamp: 1, wallTime: 1, collectionTime: 0, resourceOverrides: [], isMainFrame: true } });
const encode = prepared => Buffer.concat(Array.from(prepared.chunks(), bytes => Buffer.from(bytes)));
async function check(name, callback) { await callback(); report.checks.push(name); }
async function fixture() {
  const resources = await TraceResources.create();
  const writer = await TraceWriter.create(resources);
  return { resources, writer, async dispose() { await writer.dispose(); await resources.dispose(); } };
}
try {
  await check('bounded chunks match JSON for escapes, lone surrogates and split astral pairs', async () => {
    const text = 'a'.repeat(8191) + '\ud83d\ude00' + '\u0000\n\\"\ud800!\udfff' + 'x'.repeat(100000);
    const value = event(text);
    const prepared = prepareSnapshotRecord(value);
    const bytes = encode(prepared);
    assert.equal(bytes.toString(), JSON.stringify(value) + '\n');
    assert.equal(bytes.length, prepared.byteLength);
    assert.ok([...prepared.chunks()].every(chunk => chunk.length <= 65536));
    assert.equal(JSON.parse(bytes).snapshot.html[2], text);
  });
  await check('exact record cap is admitted and one extra byte is rejected', async () => {
    const base = prepareSnapshotRecord(event()).byteLength;
    const exact = event('a'.repeat(maximumSnapshotRecordBytes - base));
    assert.equal(prepareSnapshotRecord(exact).byteLength, maximumSnapshotRecordBytes);
    assert.throws(() => prepareSnapshotRecord(event('a'.repeat(maximumSnapshotRecordBytes - base + 1))), /byte limit/);
  });
  await check('wrapper and snapshot grammar are independently validated', async () => {
    const wrapper = event(); wrapper.snapshot.callId = 'x'.repeat(65536);
    assert.throws(() => prepareSnapshotRecord(wrapper), /byte limit/);
    const malformed = event(); malformed.snapshot.html = [[0, 0]];
    assert.throws(() => prepareSnapshotRecord(malformed), /reference index/);
    const alias = event(); alias.snapshot.resourceOverrides = [{ url: 'https://example.test/a.css', sha1: '../private' }];
    assert.throws(() => prepareSnapshotRecord(alias), /resource alias/);
  });
  await check('accessors are never invoked and admitted input cannot change while queued', async () => {
    let reads = 0;
    const unsafe = event(); Object.defineProperty(unsafe.snapshot, 'html', { enumerable: true, get() { reads++; return ['DIV', {}]; } });
    assert.throws(() => prepareSnapshotRecord(unsafe), /own data properties/); assert.equal(reads, 0);
    const safe = event('before'); prepareSnapshotRecord(safe);
    assert.throws(() => { safe.snapshot.html[2] = 'after'; }, TypeError);
    assert.ok(Object.isFrozen(safe.snapshot.html[1]));
  });
  await check('snapshot and ordinary events retain append order in the actual stream', async () => {
    const { writer, dispose } = await fixture();
    try {
      writer.append({ type: 'before-test', value: 1 });
      const value = event('payload'.repeat(50000));
      const pending = writer.appendSnapshot(value, new AbortController().signal);
      writer.append({ type: 'after-test', value: 2 });
      await pending; await writer.finish(undefined, new AbortController().signal);
      const lines = (await readFile(join(writer.directory, 'trace.trace'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
      assert.deepEqual(lines, [{ type: 'before-test', value: 1 }, value, { type: 'after-test', value: 2 }]);
    } finally { await dispose(); }
  });
  await check('partial snapshot abort fails export and preserves the prior destination', async () => {
    const { writer, dispose } = await fixture();
    const destination = join(output, 'prior-destination.zip'); await writeFile(destination, 'prior bytes');
    try {
      const cancellation = new AbortController();
      const originalWrite = writer.file.writeFile.bind(writer.file);
      let writes = 0;
      writer.file.writeFile = async bytes => { await originalWrite(bytes); if (++writes === 1) cancellation.abort(new Error('cancel streamed snapshot')); };
      await assert.rejects(writer.appendSnapshot(event('a'.repeat(500000)), cancellation.signal), /cancel streamed snapshot/);
      assert.ok((await readFile(join(writer.directory, 'trace.trace'))).length > 0);
      await assert.rejects(writer.finish(destination, new AbortController().signal), /cancel streamed snapshot/);
      assert.equal(await readFile(destination, 'utf8'), 'prior bytes');
    } finally { await dispose(); }
  });
  await check('a blocked snapshot admits no second large record queue', async () => {
    const { writer, dispose } = await fixture();
    const entered = deferred(); const release = deferred();
    const originalWrite = writer.file.writeFile.bind(writer.file);
    writer.file.writeFile = async bytes => { entered.resolve(); await release.promise; await originalWrite(bytes); };
    const first = writer.appendSnapshot(event('a'.repeat(500000)), new AbortController().signal);
    const firstRejected = assert.rejects(first, /already pending/);
    try {
      await entered.promise;
      await assert.rejects(writer.appendSnapshot(event('second'), new AbortController().signal), /already pending/);
      release.resolve(); await firstRejected;
    } finally { release.resolve(); await dispose(); }
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(join(output, 'report.json')); }
