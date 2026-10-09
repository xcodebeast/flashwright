import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import filesystem from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { TraceResources, maximumSourceBytes } = require('../packages/flashwright-core/dist/commonjs/trace-resources.js');
const { TraceWriter } = require('../packages/flashwright-core/dist/commonjs/trace-writer.js');
const { Tracing } = require('../packages/flashwright-core/dist/commonjs/tracing.js');
const { instrumentTraceMethods } = require('../packages/flashwright-core/dist/commonjs/trace-hooks.js');
const { utils } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const directory = await filesystem.mkdtemp(join(tmpdir(), 'flashwright-source-tests-'));
const checks = [];
const archives = [];
const signal = () => new AbortController().signal;
const sourceAlias = path => `resources/src@${createHash('sha1').update(path).digest('hex')}.txt`;
const deferred = () => { let resolve; const promise = new Promise(fulfill => { resolve = fulfill; }); return { promise, resolve }; };
async function check(name, callback) { await callback(); checks.push(name); }
async function withResources(callback) {
  const resources = await TraceResources.create();
  try { return await callback(resources); } finally { await resources.dispose(); }
}
async function exportSources(resources, paths, name) {
  const writer = await TraceWriter.create(resources);
  const path = join(directory, name);
  try {
    writer.append({ type: 'test', value: name });
    writer.referenceSources(paths.map(file => ({ file })));
    await writer.finish(path, signal());
    archives.push(path);
    const archive = new utils.ZipFile(path);
    try {
      const entries = await archive.entries();
      return Object.fromEntries(await Promise.all(entries.map(async name => [name, await archive.read(name)])));
    } finally { archive.close(); }
  } finally { await writer.dispose(); }
}
class DiagnosticDriver {
  generation;
  async request(method, parameters) {
    if (method === 'context.trace.start') { this.generation = parameters.generation; return null; }
    assert.equal(parameters.generation, this.generation);
    if (method === 'context.trace.stop') this.generation = undefined;
    return { generation: parameters.generation, events: [] };
  }
}
class Operations {
  constructor(tracing) { this.tracing = tracing; }
  async value(value) { return value; }
  async reject(error) { throw error; }
}
instrumentTraceMethods(Operations.prototype, 'Page', owner => ({ tracing: owner.tracing }), { value: { parameters: ['value'] }, reject: {} });
try {
  await check('binary and file ingests share immutable publication and physical deduplication', () => withResources(async resources => {
    const bytes = Buffer.from([255, 216, 0, 255, 217]);
    const source = join(directory, 'binary-resource');
    await filesystem.writeFile(source, bytes);
    const [file, binary] = await Promise.all([resources.captureFile(source, signal()), resources.captureBytes(Buffer.from(bytes), signal())]);
    assert.equal(file, binary);
    assert.deepEqual(await filesystem.readFile(binary.path), bytes);
    assert.equal((await filesystem.readdir(resources.directory)).length, 1);
    assert.equal(resources.bytes, bytes.length);
  }));
  await check('aborted binary ingestion retains its file and buffer owner through cleanup', async () => {
    const resources = await TraceResources.create();
    const originalOpen = filesystem.open;
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    filesystem.open = async (...arguments_) => {
      const handle = await originalOpen(...arguments_);
      if (String(arguments_[0]).startsWith(resources.directory)) {
        const originalWrite = handle.writeFile.bind(handle);
        handle.writeFile = async bytes => { entered.resolve(); await release.promise; return originalWrite(bytes); };
      }
      return handle;
    };
    let work;
    try {
      work = resources.captureBytes(Buffer.from('pending image'), controller.signal);
      const rejection = assert.rejects(work);
      await entered.promise;
      controller.abort(new Error('capture canceled'));
      let disposed = false;
      const disposal = resources.dispose().then(() => { disposed = true; });
      await Promise.resolve();
      assert.equal(disposed, false);
      release.resolve();
      await rejection;
      await disposal;
      await assert.rejects(filesystem.access(resources.directory), { code: 'ENOENT' });
    } finally { release.resolve(); filesystem.open = originalOpen; await work?.catch(() => {}); await resources.dispose(); }
  });
  await check('source aliases preserve path identity while immutable bytes deduplicate', () => withResources(async resources => {
    const first = join(directory, 'first.ts'); const second = join(directory, 'second.ts');
    const bytes = Buffer.from('\ufeffconst unicode = "λ café";\r\n');
    await filesystem.writeFile(first, bytes); await filesystem.writeFile(second, bytes);
    const entries = await exportSources(resources, [first, second, first], 'dedup.zip');
    assert.deepEqual(Object.keys(entries).sort(), ['trace.trace', 'trace.network', sourceAlias(first), sourceAlias(second)].sort());
    assert.deepEqual(entries[sourceAlias(first)], bytes); assert.deepEqual(entries[sourceAlias(second)], bytes);
    assert.equal((await filesystem.readdir(resources.directory)).length, 1);
  }));
  await check('export refreshes changed paths and omits deleted paths across chunks', () => withResources(async resources => {
    const source = join(directory, 'changing.ts');
    await filesystem.writeFile(source, 'const version = 1;\n');
    const first = await exportSources(resources, [source], 'version1.zip');
    await filesystem.writeFile(source, 'const version = 2;\n');
    const second = await exportSources(resources, [source], 'version2.zip');
    await filesystem.unlink(source);
    const third = await exportSources(resources, [source], 'deleted.zip');
    assert.equal(first[sourceAlias(source)].toString(), 'const version = 1;\n');
    assert.equal(second[sourceAlias(source)].toString(), 'const version = 2;\n');
    assert.equal(third[sourceAlias(source)], undefined);
    assert.equal((await filesystem.readdir(resources.directory)).length, 2);
  }));
  await check('missing paths and non-files omit while symlinks retain the caller alias', () => withResources(async resources => {
    const source = join(directory, 'linked-original.ts'); const link = join(directory, 'linked-alias.ts');
    await filesystem.writeFile(source, 'export const linked = true;'); await filesystem.symlink(source, link);
    const entries = await exportSources(resources, [link, directory, join(directory, 'missing.ts')], 'missing.zip');
    assert.equal(entries[sourceAlias(link)].toString(), 'export const linked = true;');
    assert.equal(entries[sourceAlias(source)], undefined); assert.equal(Object.keys(entries).length, 3);
  }));
  await check('FIFO and regular-path-to-FIFO swap cannot block source opening', () => withResources(async resources => {
    const fifo = join(directory, 'direct.fifo'); const swapped = join(directory, 'swapped.ts');
    execFileSync('mkfifo', [fifo]); await filesystem.writeFile(swapped, 'original');
    const originalOpen = filesystem.open;
    let swappedOnce = false;
    filesystem.open = async (path, flags, ...rest) => {
      if (path === fifo || path === swapped) assert.ok(flags & constants.O_NONBLOCK);
      if (path === swapped && !swappedOnce) {
        swappedOnce = true; await filesystem.unlink(swapped); execFileSync('mkfifo', [swapped]);
      }
      return originalOpen(path, flags, ...rest);
    };
    try {
      const entries = await exportSources(resources, [fifo, swapped], 'fifo.zip');
      assert.equal(Object.keys(entries).length, 2); assert.equal(swappedOnce, true);
    } finally { filesystem.open = originalOpen; }
  }));
  await check('concurrent identical ingests await publication before sharing the blob', () => withResources(async resources => {
    const source = join(directory, 'concurrent.ts'); await filesystem.writeFile(source, 'same bytes');
    const entered = deferred(); const released = deferred(); const originalRename = filesystem.rename;
    let renames = 0;
    filesystem.rename = async (...arguments_) => { renames++; entered.resolve(); await released.promise; return originalRename(...arguments_); };
    try {
      const first = resources.captureFile(source, signal()); await entered.promise;
      let secondFinished = false;
      const second = resources.captureFile(source, signal()).then(resource => { secondFinished = true; return resource; });
      await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(secondFinished, false);
      released.resolve(); const [one, two] = await Promise.all([first, second]);
      assert.equal(one, two); assert.equal(renames, 1); assert.equal((await filesystem.readdir(resources.directory)).length, 1);
      assert.equal((await filesystem.readFile(one.path)).toString(), 'same bytes');
    } finally { released.resolve(); filesystem.rename = originalRename; }
  }));
  await check('recording disposal waits for archive-owner leases', async () => {
    const resources = await TraceResources.create(); const writer = await TraceWriter.create(resources);
    let disposed = false; const disposal = resources.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(disposed, false);
    await filesystem.access(resources.directory); await writer.dispose(); await disposal;
    await assert.rejects(filesystem.access(resources.directory), { code: 'ENOENT' });
  });
  await check('in-place source mutation rejects without replacing the destination', () => withResources(async resources => {
    const source = join(directory, 'mutating.ts'); const destination = join(directory, 'mutating.zip');
    await filesystem.writeFile(source, 'before'); await filesystem.writeFile(destination, 'preserved');
    const originalOpen = filesystem.open;
    filesystem.open = async (path, ...arguments_) => {
      const handle = await originalOpen(path, ...arguments_);
      if (path === source) {
        const originalRead = handle.read.bind(handle); let mutated = false;
        handle.read = async (...arguments_) => { const result = await originalRead(...arguments_); if (!mutated) { mutated = true; await filesystem.appendFile(source, '-after'); } return result; };
      }
      return handle;
    };
    const writer = await TraceWriter.create(resources);
    try {
      writer.referenceSources([{ file: source }]);
      await assert.rejects(writer.finish(destination, signal()), { name: 'ProtocolError' });
      assert.equal(await filesystem.readFile(destination, 'utf8'), 'preserved');
      assert.deepEqual(await filesystem.readdir(resources.directory), []);
    } finally { filesystem.open = originalOpen; await writer.dispose(); }
  }));
  await check('discarded chunks never read their referenced source files', () => withResources(async resources => {
    const writer = await TraceWriter.create(resources); const originalCapture = resources.captureFile;
    resources.captureFile = () => { throw Error('discard must not read sources'); };
    try { writer.referenceSources([{ file: join(directory, 'first.ts') }]); await writer.finish(undefined, signal()); }
    finally { resources.captureFile = originalCapture; await writer.dispose(); }
  }));
  await check('oversized sources and source path admission fail explicitly', () => withResources(async resources => {
    const source = join(directory, 'oversized.ts'); const handle = await filesystem.open(source, 'w');
    await handle.truncate(maximumSourceBytes + 1); await handle.close();
    const writer = await TraceWriter.create(resources);
    try { writer.referenceSources([{ file: source }]); await assert.rejects(writer.finish(join(directory, 'oversized.zip'), signal()), { name: 'ResourceLimitError' }); }
    finally { await writer.dispose(); }
    const countWriter = await TraceWriter.create(resources);
    try {
      countWriter.referenceSources(Array.from({ length: 4097 }, (_, index) => ({ file: `file-${index}.ts` })));
      await assert.rejects(countWriter.finish(undefined, signal()), { name: 'ResourceLimitError' });
    } finally { await countWriter.dispose(); }
    const metadataWriter = await TraceWriter.create(resources);
    try {
      metadataWriter.referenceSources(Array.from({ length: 64 }, (_, index) => ({ file: `${index}-${'λ'.repeat(16384)}` })));
      await assert.rejects(metadataWriter.finish(undefined, signal()), { name: 'ResourceLimitError' });
    } finally { await metadataWriter.dispose(); }
  }));
  await check('aliases reject traversal, conflicting bytes and unowned resources', () => withResources(async resources => {
    const first = await resources.captureFile(join(directory, 'first.ts'), signal());
    const second = await resources.captureFile(join(directory, 'concurrent.ts'), signal());
    const writer = await TraceWriter.create(resources); const name = `resources/${'a'.repeat(64)}`;
    try {
      writer.addResource(name, first); writer.addResource(name, first);
      assert.throws(() => writer.addResource(name, second), { name: 'ProtocolError' });
      assert.throws(() => writer.addResource('../escape', first), { name: 'ProtocolError' });
      assert.throws(() => writer.addResource(`resources/${'b'.repeat(64)}`, { ...first }), { name: 'ProtocolError' });
      for (let index = 1; index < 8192; index++) writer.addResource(`resources/${index.toString(16).padStart(64, '0')}`, first);
      assert.throws(() => writer.addResource(`resources/${'c'.repeat(64)}`, first), { name: 'ResourceLimitError' });
    } finally { await writer.dispose(); }
  }));
  await check('archive byte limit charges duplicated aliases before destination changes', () => withResources(async resources => {
    const source = join(directory, 'blob'); const handle = await filesystem.open(source, 'w'); await handle.truncate(16 * 1024 * 1024); await handle.close();
    const blob = await resources.captureFile(source, signal()); const writer = await TraceWriter.create(resources);
    const destination = join(directory, 'too-many-bytes.zip'); await filesystem.writeFile(destination, 'preserved');
    try {
      for (let index = 0; index < 32; index++) writer.addResource(`resources/${index.toString(16).padStart(64, '0')}`, blob);
      await assert.rejects(writer.finish(destination, signal()), { name: 'ResourceLimitError' });
      assert.equal(await filesystem.readFile(destination, 'utf8'), 'preserved');
    } finally { await writer.dispose(); }
  }));
  await check('source capture failure preserves original public results and rejection identity', async () => {
    const tracing = new Tracing(new DiagnosticDriver(), 'source-failure', null); const operations = new Operations(tracing);
    const originalCapture = TraceResources.prototype.captureFile; const sourceError = Error('source read failed');
    const destination = join(directory, 'source-failure.zip'); await filesystem.writeFile(destination, 'preserved');
    TraceResources.prototype.captureFile = async () => { throw sourceError; };
    try {
      await tracing.start({ sources: true }); const result = {}; const rejection = Error('original browser failure');
      assert.equal(await operations.value(result), result); await assert.rejects(operations.reject(rejection), error => error === rejection);
      await assert.rejects(tracing.stop({ path: destination }), error => error === sourceError);
      assert.equal(await filesystem.readFile(destination, 'utf8'), 'preserved'); await tracing.cleanup;
    } finally { TraceResources.prototype.captureFile = originalCapture; tracing.ownerClosed(); await tracing.cleanup; }
  });
  await check('sources:false and discarded sources:true make no file-capture calls', async () => {
    const originalCapture = TraceResources.prototype.captureFile;
    TraceResources.prototype.captureFile = () => { throw Error('unexpected source capture'); };
    try {
      for (const sources of [false, true]) {
        const tracing = new Tracing(new DiagnosticDriver(), `off-${sources}`, null); const operations = new Operations(tracing);
        try { await tracing.start({ sources }); await operations.value(11); await tracing.stop(sources ? {} : { path: join(directory, 'off.zip') }); }
        finally { tracing.ownerClosed(); await tracing.cleanup; }
      }
    } finally { TraceResources.prototype.captureFile = originalCapture; }
  });
  await check('failed blob publication leaves no referenced or temporary resource', () => withResources(async resources => {
    const originalRename = filesystem.rename; const originalError = Error('resource rename failed');
    filesystem.rename = async () => { throw originalError; };
    try { await assert.rejects(resources.captureFile(join(directory, 'first.ts'), signal()), error => error === originalError); }
    finally { filesystem.rename = originalRename; }
    assert.deepEqual(await filesystem.readdir(resources.directory), []);
    const resource = await resources.captureFile(join(directory, 'first.ts'), signal());
    assert.equal(resources.owns(resource), true);
  }));
  await check('ingest admission rejects a third file without retaining unbounded work', () => withResources(async resources => {
    const originalOpen = filesystem.open; const bothEntered = deferred(); const release = deferred(); let entered = 0;
    const source = join(directory, 'concurrent.ts');
    filesystem.open = async (path, ...arguments_) => {
      if (path === source) { if (++entered === 2) bothEntered.resolve(); await release.promise; }
      return originalOpen(path, ...arguments_);
    };
    const first = resources.captureFile(source, signal()); const second = resources.captureFile(source, signal());
    try { await bothEntered.promise; await assert.rejects(resources.captureFile(source, signal()), { name: 'ResourceLimitError' }); }
    finally { release.resolve(); filesystem.open = originalOpen; await Promise.all([first, second]); }
  }));
  await check('aborted source read removes its partial blob and closes ownership', () => withResources(async resources => {
    const source = join(directory, 'abort.ts'); await filesystem.writeFile(source, Buffer.alloc(131072));
    const cancellation = new AbortController(); const originalError = Error('cancel source'); const originalOpen = filesystem.open;
    filesystem.open = async (path, ...arguments_) => {
      const handle = await originalOpen(path, ...arguments_);
      if (path === source) {
        const originalRead = handle.read.bind(handle);
        handle.read = async (...arguments_) => { const result = await originalRead(...arguments_); cancellation.abort(originalError); return result; };
      }
      return handle;
    };
    try { await assert.rejects(resources.captureFile(source, cancellation.signal), error => error === originalError); }
    finally { filesystem.open = originalOpen; }
    assert.deepEqual(await filesystem.readdir(resources.directory), []);
  }));
  await check('owner closure interrupts precommit source I/O and retains late cleanup ownership', async () => {
    const tracing = new Tracing(new DiagnosticDriver(), 'close-source', null); const operations = new Operations(tracing);
    const originalCapture = TraceResources.prototype.captureFile; const originalSetTimeout = globalThis.setTimeout;
    const entered = deferred(); const release = deferred(); const destination = join(directory, 'closed-source.zip');
    await filesystem.writeFile(destination, 'preserved');
    TraceResources.prototype.captureFile = async function(...arguments_) { entered.resolve(); await release.promise; return originalCapture.apply(this, arguments_); };
    globalThis.setTimeout = (callback, delay, ...arguments_) => originalSetTimeout(callback, delay === 2000 ? 10 : delay, ...arguments_);
    try {
      await tracing.start({ sources: true }); await operations.value(42);
      const exportResult = tracing.stop({ path: destination }); const failure = assert.rejects(exportResult, { name: 'TargetClosedError' });
      await entered.promise; tracing.ownerClosed(); await failure;
      assert.ok(tracing.cleanup, 'pending file I/O remains owned after foreground grace');
      assert.equal(await filesystem.readFile(destination, 'utf8'), 'preserved');
      release.resolve(); await tracing.cleanup;
      assert.equal(await filesystem.readFile(destination, 'utf8'), 'preserved');
      assert.equal(tracing.cleanup, undefined);
    } finally { release.resolve(); TraceResources.prototype.captureFile = originalCapture; globalThis.setTimeout = originalSetTimeout; tracing.ownerClosed(); await tracing.cleanup; }
  });
  await check('owner closure after atomic commit dispatch waits for the definitive rename', async () => {
    const tracing = new Tracing(new DiagnosticDriver(), 'commit-close', null); const operations = new Operations(tracing);
    const destination = join(directory, 'commit-close.zip'); await filesystem.writeFile(destination, 'preserved');
    const originalRename = filesystem.rename; const entered = deferred(); const release = deferred();
    filesystem.rename = async (source, target) => { if (target === destination) { entered.resolve(); await release.promise; } return originalRename(source, target); };
    try {
      await tracing.start({ sources: true }); await operations.value(43);
      let settled = false; const exporting = tracing.stop({ path: destination }).finally(() => { settled = true; });
      await entered.promise; tracing.ownerClosed(); await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(settled, false, 'in-flight commit retains definitive ownership');
      release.resolve(); await exporting; archives.push(destination);
      assert.notEqual((await filesystem.readFile(destination)).toString(), 'preserved');
    } finally { release.resolve(); filesystem.rename = originalRename; tracing.ownerClosed(); await tracing.cleanup; }
  });
  await check('source preparation deadline quarantines late I/O before another recording', async () => {
    const tracing = new Tracing(new DiagnosticDriver(), 'source-deadline', null); const operations = new Operations(tracing);
    const originalCapture = TraceResources.prototype.captureFile; const originalSetTimeout = globalThis.setTimeout;
    const release = deferred(); const destination = join(directory, 'source-deadline.zip');
    await filesystem.writeFile(destination, 'preserved');
    TraceResources.prototype.captureFile = async function(...arguments_) { await release.promise; return originalCapture.apply(this, arguments_); };
    globalThis.setTimeout = (callback, delay, ...arguments_) => originalSetTimeout(callback, delay === 30000 || delay === 2000 ? 10 : delay, ...arguments_);
    try {
      await tracing.start({ sources: true }); assert.equal(await operations.value(44), 44);
      await assert.rejects(tracing.stop({ path: destination }), { name: 'TimeoutError' });
      await assert.rejects(tracing.start({ sources: true }), { name: 'ResourceLimitError' });
      assert.equal(await filesystem.readFile(destination, 'utf8'), 'preserved');
      release.resolve(); await tracing.cleanup;
      await tracing.start({ sources: true }); await tracing.stop();
    } finally { release.resolve(); TraceResources.prototype.captureFile = originalCapture; globalThis.setTimeout = originalSetTimeout; tracing.ownerClosed(); await tracing.cleanup; }
  });
  await check('resource tampering after sealing is detected before destination replacement', () => withResources(async resources => {
    const blob = await resources.captureFile(join(directory, 'concurrent.ts'), signal());
    const writer = await TraceWriter.create(resources); const destination = join(directory, 'tampered.zip');
    await filesystem.writeFile(destination, 'preserved'); writer.addResource(`resources/${blob.contentHash}`, blob);
    await filesystem.writeFile(blob.path, Buffer.alloc(blob.byteLength, 97));
    try { await assert.rejects(writer.finish(destination, signal()), { name: 'ProtocolError' }); assert.equal(await filesystem.readFile(destination, 'utf8'), 'preserved'); }
    finally { await writer.dispose(); }
  }));
  await check('recording closure rejects a late ingest and waits for its file ownership', async () => {
    const resources = await TraceResources.create(); const originalOpen = filesystem.open; const entered = deferred(); const release = deferred();
    const source = join(directory, 'concurrent.ts');
    filesystem.open = async (path, ...arguments_) => { if (path === source) { entered.resolve(); await release.promise; } return originalOpen(path, ...arguments_); };
    const capturing = resources.captureFile(source, signal()); const rejected = assert.rejects(capturing, { name: 'TargetClosedError' });
    try {
      await entered.promise; let disposed = false; const disposal = resources.dispose().then(() => { disposed = true; });
      await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(disposed, false);
      release.resolve(); await rejected; await disposal;
      await assert.rejects(filesystem.access(resources.directory), { code: 'ENOENT' });
    } finally { release.resolve(); filesystem.open = originalOpen; await capturing.catch(() => {}); await resources.dispose(); }
  });
  await check('recording byte reservations reject overflow and remove incomplete resources', () => withResources(async resources => {
    const source = join(directory, 'recording-budget'); const size = 16 * 1024 * 1024;
    const handle = await filesystem.open(source, 'w+');
    try {
      await handle.truncate(size);
      for (let index = 0; index < 16; index++) {
        await handle.write(Buffer.from([index]), 0, 1, 0);
        await resources.captureFile(source, signal());
      }
      await handle.write(Buffer.from([16]), 0, 1, 0);
      await assert.rejects(resources.captureFile(source, signal()), { name: 'ResourceLimitError' });
      const files = await filesystem.readdir(resources.directory);
      assert.equal(files.length, 16); assert.equal(files.some(file => file.endsWith('.tmp')), false);
      let bytes = 0; for (const file of files) bytes += (await filesystem.stat(join(resources.directory, file))).size;
      assert.equal(bytes, 256 * 1024 * 1024);
    } finally { await handle.close(); }
  }));
  for (const path of archives) execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None', path]);
  console.log(JSON.stringify({ status: 'passed', checks, archivesVerified: archives.length }, null, 2));
} finally { await filesystem.rm(directory, { recursive: true, force: true }); }
