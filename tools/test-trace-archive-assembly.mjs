import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { SealedTraceArchive } = require('../packages/flashwright-core/dist/commonjs/trace-archive.js');
const { TraceArchiveAssembly } = require('../packages/flashwright-core/dist/commonjs/trace-archive-assembly.js');
const { TraceResources } = require('../packages/flashwright-core/dist/commonjs/trace-resources.js');
const { TraceWriter } = require('../packages/flashwright-core/dist/commonjs/trace-writer.js');
const { runnerIntegration } = require('../packages/flashwright-core/dist/commonjs/runner-integration.js');
const { utils, iso } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const directory = await mkdtemp(join(tmpdir(), 'flashwright-assembly-tests-'));
const report = { status: 'running', checks: [] };
const hash = value => createHash('sha256').update(value).digest('hex');
const signal = () => new AbortController().signal;
const empty = name => ({ name, byteLength: 0, contentHash: hash('') });
const deferred = () => { let resolve; const promise = new Promise(complete => { resolve = complete; }); return { promise, resolve }; };
let nextFile = 0;
const exported = [];
async function check(name, callback) { await callback(); report.checks.push(name); }
async function entry(name, content) {
  const path = join(directory, `input-${++nextFile}`); await writeFile(path, content);
  return { name, path, byteLength: Buffer.byteLength(content), contentHash: hash(content) };
}
function archive(entries, cleanup = async () => {}) { return new SealedTraceArchive(entries, cleanup); }
function assertReaderAvailable(value) { const reader = value.acquire(); reader.release(); }

try {
  await check('private assembly version is enforced and the public facade stays clean', async () => {
    assert.equal(runnerIntegration.version, 13);
    assert.throws(() => runnerIntegration.createTraceArchiveAssembly(3), { name: 'ProtocolError' });
    const assembly = runnerIntegration.createTraceArchiveAssembly(4);
    assert.equal(assembly instanceof TraceArchiveAssembly, true);
    assert.equal('TraceArchiveAssembly' in require('../packages/flashwright-core/dist/commonjs/index.js'), false);
    assert.throws(() => assembly.seal(), /no inputs/);
    await assembly.dispose();
  });

  await check('original stream ordinals and latest source aliases match the pinned reverse merge', async () => {
    const sourceName = `resources/src@${'1'.repeat(40)}.txt`;
    const resource = await entry(`resources/${hash('shared payload')}`, 'shared payload');
    const inputs = [];
    const assembly = new TraceArchiveAssembly();
    let combined;
    try {
      for (const [index, source] of ['earlier source', 'later source'].entries()) {
        const context = { version: 8, type: 'context-options', origin: 'library', browserName: 'chromium', playwrightVersion: '1.60.0', options: {}, wallTime: 1000, monotonicTime: 1, sdkLanguage: 'javascript', contextId: `context-${index}` };
        const input = archive([await entry('trace.trace', JSON.stringify(context) + '\n'), empty('trace.network'), await entry(sourceName, source), resource]);
        inputs.push(input); assembly.addLibrary(input);
      }
      const context = { version: 8, type: 'context-options', origin: 'testRunner', browserName: '', playwrightVersion: '1.60.0', options: {}, wallTime: 1000, monotonicTime: 1, sdkLanguage: 'javascript', testTimeout: 12345 };
      const runner = archive([await entry('test.trace', JSON.stringify(context) + '\n'), await entry(sourceName, 'runner source')]);
      inputs.push(runner); assembly.addRunner(runner);
      combined = assembly.seal();
      await assembly.dispose();
      for (const input of inputs) assert.throws(() => input.acquire(), /active reader/);
      const path = join(directory, 'combined.zip'); await combined.export(path, signal()); exported.push(path);
      const zip = new utils.ZipFile(path);
      try {
        const names = await zip.entries();
        assert.deepEqual(names.filter(name => name.endsWith('.trace')), ['0-trace.trace', '1-trace.trace', 'test.trace']);
        assert.deepEqual(names.filter(name => name.endsWith('.network')), ['0-trace.network', '1-trace.network']);
        assert.equal(names.filter(name => name === resource.name).length, 1);
        assert.equal((await zip.read(sourceName)).toString(), 'runner source');
        const loader = new iso.TraceLoader();
        await loader.load({ entryNames: async () => names, readText: async name => names.includes(name) ? (await zip.read(name)).toString() : undefined, hasEntry: async name => names.includes(name), isLive: () => false });
        assert.equal(loader.contextEntries.length, 3);
        assert.equal(loader.contextEntries.find(context => context.origin === 'testRunner').testTimeout, 12345);
      } finally { zip.close(); }
      assert.throws(() => assembly.seal(), { name: 'TargetClosedError' });
    } finally { await combined?.dispose(); await assembly.dispose(); for (const input of inputs) await input.dispose(); }
  });

  await check('rejected role, duplicate owner and resource conflict keep caller custody and prior inputs', async () => {
    const assembly = new TraceArchiveAssembly();
    const resourceName = `resources/${'2'.repeat(64)}`;
    const first = archive([empty('trace.trace'), await entry(resourceName, 'one')]);
    const conflict = archive([empty('trace.trace'), await entry(resourceName, 'different')]);
    const wrongRole = archive([empty('test.trace')]);
    const successor = archive([empty('trace.trace')]);
    let combined;
    try {
      assembly.addLibrary(first);
      assert.throws(() => assembly.addLibrary(first), /already been admitted/);
      assert.throws(() => assembly.addLibrary(wrongRole), /outside its original archive role/);
      assertReaderAvailable(wrongRole);
      assert.throws(() => assembly.addLibrary(conflict), /conflicting bytes/);
      assertReaderAvailable(conflict);
      assembly.addLibrary(successor);
      combined = assembly.seal();
      const reader = combined.acquire();
      assert.deepEqual(reader.entries.map(value => value.name), ['0-trace.trace', resourceName, '1-trace.trace']); reader.release();
    } finally { await combined?.dispose(); await assembly.dispose(); await first.dispose(); await conflict.dispose(); await wrongRole.dispose(); await successor.dispose(); }
  });

  await check('without a runner source the latest library capture wins a changed source-path alias', async () => {
    const name = `resources/src@${'4'.repeat(40)}.txt`;
    const assembly = new TraceArchiveAssembly();
    assembly.addLibrary(archive([empty('trace.trace'), await entry(name, 'old source bytes')]));
    assembly.addLibrary(archive([empty('trace.trace'), await entry(name, 'new source bytes')]));
    const combined = assembly.seal();
    try {
      const reader = combined.acquire();
      try { assert.equal(await readFile(reader.entries.find(entry => entry.name === name).path, 'utf8'), 'new source bytes'); }
      finally { reader.release(); }
    } finally { await combined.dispose(); await assembly.dispose(); }
  });

  await check('the runner is the final input and a rejected later library is still independently owned', async () => {
    const assembly = new TraceArchiveAssembly(); const runner = archive([empty('test.trace')]); const library = archive([empty('trace.trace')]);
    try {
      assembly.addRunner(runner);
      assert.throws(() => assembly.addLibrary(library), /final input/); assertReaderAvailable(library);
    } finally { await assembly.dispose(); await library.dispose(); }
  });

  await check('retained descriptor limits include repeated aliases before deduplication', async () => {
    const entries = [empty('trace.trace'), ...Array.from({ length: 8000 }, (_, index) => empty(`resources/${index.toString(16).padStart(64, '0')}`))];
    const inputs = Array.from({ length: 5 }, () => archive(entries)); const assembly = new TraceArchiveAssembly();
    try {
      for (const input of inputs.slice(0, 4)) assembly.addLibrary(input);
      assert.throws(() => assembly.addLibrary(inputs[4]), /retained archive metadata/); assertReaderAvailable(inputs[4]);
    } finally { await assembly.dispose(); for (const input of inputs) await input.dispose(); }
  });

  await check('manifest snapshots drop undeclared properties and bound paths and retained descriptor text', async () => {
    let accessed = 0;
    const input = archive([{ ...empty('trace.trace'), get extra() { accessed++; throw Error('undeclared getter'); } }]);
    const reader = input.acquire();
    assert.equal(accessed, 0); assert.equal(Object.hasOwn(reader.entries[0], 'extra'), false); reader.release(); await input.dispose();
    assert.throws(() => archive([{ ...empty('trace.trace'), path: 'x'.repeat(32769) }]), /path or descriptor-text limit/);
    const entries = [empty('trace.trace'), ...Array.from({ length: 480 }, (_, index) => ({ ...empty(`resources/${index.toString(16).padStart(64, '0')}`), path: 'x'.repeat(8192) }))];
    assert.throws(() => archive([...entries, ...Array.from({ length: 40 }, (_, index) => ({ ...empty(`resources/${(1000 + index).toString(16).padStart(64, '0')}`), path: 'y'.repeat(8192) }))]), /descriptor-text limit/);
    const inputs = Array.from({ length: 5 }, () => archive(entries)); const assembly = new TraceArchiveAssembly();
    try {
      for (const input of inputs.slice(0, 4)) assembly.addLibrary(input);
      assert.throws(() => assembly.addLibrary(inputs[4]), /retained archive metadata/); assertReaderAvailable(inputs[4]);
    } finally { await assembly.dispose(); for (const input of inputs) await input.dispose(); }
  });

  await check('retained byte and final ZIP limits reject before any source reads', async () => {
    const fakeResource = { name: `resources/${'3'.repeat(64)}`, path: join(directory, 'must-not-open'), byteLength: 384 * 1024 * 1024, contentHash: hash('descriptor-only quota test') };
    const inputs = Array.from({ length: 3 }, () => archive([empty('trace.trace'), fakeResource])); const assembly = new TraceArchiveAssembly();
    try {
      assembly.addLibrary(inputs[0]); assembly.addLibrary(inputs[1]);
      assert.throws(() => assembly.addLibrary(inputs[2]), /retained archive metadata or source bytes/); assertReaderAvailable(inputs[2]);
    } finally { await assembly.dispose(); for (const input of inputs) await input.dispose(); }
    const first = archive([{ ...fakeResource, name: 'trace.trace', byteLength: 300 * 1024 * 1024 }]);
    const second = archive([{ ...fakeResource, name: 'trace.trace', byteLength: 300 * 1024 * 1024 }]);
    const outputLimited = new TraceArchiveAssembly();
    try {
      outputLimited.addLibrary(first);
      assert.throws(() => outputLimited.addLibrary(second), /archive byte or central-directory limit/); assertReaderAvailable(second);
    } finally { await outputLimited.dispose(); await second.dispose(); }
  });

  await check('archive count limits reject the next owner without taking its reader', async () => {
    const assembly = new TraceArchiveAssembly(); const inputs = Array.from({ length: 1025 }, () => archive([empty('trace.trace')]));
    try {
      for (const input of inputs.slice(0, 1024)) assembly.addLibrary(input);
      assert.throws(() => assembly.addLibrary(inputs[1024]), /1024 input archives/); assertReaderAvailable(inputs[1024]);
    } finally { await assembly.dispose(); await inputs[1024].dispose(); }
  });

  await check('aggregate readers outlive builder disposal and release all shared recording leases before cleanup', async () => {
    const resources = await TraceResources.create(); const writers = [await TraceWriter.create(resources), await TraceWriter.create(resources)];
    const assembly = new TraceArchiveAssembly(); let combined;
    try {
      const resource = await resources.captureBytes(Buffer.from('retained shared bytes'), signal());
      for (const writer of writers) { writer.addResource(`resources/${resource.contentHash}`, resource); assembly.addLibrary(await writer.takeArchive(signal())); await writer.dispose(); }
      await resources.retire(); combined = assembly.seal(); await assembly.dispose();
      const reader = combined.acquire(); let disposed = false;
      const disposal = combined.dispose().then(() => { disposed = true; });
      await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, false); await access(resource.path);
      reader.release(); await disposal; await assert.rejects(access(resources.directory), { code: 'ENOENT' });
    } finally { await combined?.dispose(); await assembly.dispose(); for (const writer of writers) await writer.dispose(); await resources.dispose(); }
  });

  await check('all input cleanup settles with four workers and preserves the earliest input failure', async () => {
    const assembly = new TraceArchiveAssembly(); const gate = deferred(); const entered = deferred();
    let active = 0; let maximum = 0; const visited = []; const original = Error('original cleanup failure');
    for (let index = 0; index < 10; index++) assembly.addLibrary(archive([empty('trace.trace')], async () => {
      visited.push(index); active++; maximum = Math.max(maximum, active); if (active === 4) entered.resolve();
      await gate.promise; active--; if (index === 1) throw original; if (index === 7) throw Error('later cleanup failure');
    }));
    const disposal = assembly.dispose(); const rejected = assert.rejects(disposal, error => error === original);
    await entered.promise; assert.equal(visited.length, 4); gate.resolve(); await rejected;
    assert.equal(maximum, 4); assert.deepEqual(visited.sort((left, right) => left - right), Array.from({ length: 10 }, (_, index) => index));
    assert.equal(assembly.dispose(), disposal);
  });

  await check('composite export verifies the original input bytes and preserves an existing destination', async () => {
    const stream = await entry('trace.trace', 'original bytes'); const input = archive([stream]); const assembly = new TraceArchiveAssembly();
    assembly.addLibrary(input); const combined = assembly.seal(); const destination = join(directory, 'preserved.zip');
    try {
      await writeFile(destination, 'previous output'); await writeFile(stream.path, 'changed bytes');
      await assert.rejects(combined.export(destination, signal()), { name: 'ProtocolError' });
      assert.equal(await readFile(destination, 'utf8'), 'previous output');
    } finally { await combined.dispose(); await assembly.dispose(); }
  });

  await check('independent Python reader validates the composed ZIP checksums', async () => {
    execFileSync('python3', ['-c', 'import sys,zipfile\nfor path in sys.argv[1:]:\n with zipfile.ZipFile(path) as archive: assert archive.testzip() is None, path', ...exported]);
  });
  report.status = 'passed'; console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
