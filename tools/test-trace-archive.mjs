import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { TraceResources } = require('../packages/flashwright-core/dist/commonjs/trace-resources.js');
const { TraceWriter } = require('../packages/flashwright-core/dist/commonjs/trace-writer.js');
const { SealedTraceArchive } = require('../packages/flashwright-core/dist/commonjs/trace-archive.js');
const { utils } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const directory = await filesystem.mkdtemp(join(tmpdir(), 'flashwright-archive-tests-'));
const report = { status: 'running', checks: [] };
const signal = () => new AbortController().signal;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(fulfill => { resolve = fulfill; }); return { promise, resolve }; };
async function check(name, callback) { await callback(); report.checks.push(name); }
async function fixture(callback) {
  const resources = await TraceResources.create();
  const writer = await TraceWriter.create(resources);
  let archive;
  try { await callback({ resources, writer, async seal(cancellation = signal()) { archive = await writer.takeArchive(cancellation); return archive; } }); }
  finally { await archive?.dispose(); await writer.dispose(); await resources.dispose(); }
}

try {
  await check('retirement leaves shared sealed archives exportable and the final archive owns physical cleanup', async () => {
    const resources = await TraceResources.create();
    const writers = [await TraceWriter.create(resources), await TraceWriter.create(resources)];
    const archives = [];
    const originalRemove = filesystem.rm;
    const removalEntered = deferred(); const removalReleased = deferred();
    try {
      const resource = await resources.captureBytes(Buffer.from('shared immutable bytes'), signal());
      for (const [index, writer] of writers.entries()) {
        writer.append({ chunk: index });
        writer.addResource(`resources/${resource.contentHash}`, resource);
        archives.push(await writer.takeArchive(signal()));
        await writer.dispose();
      }
      const retirement = resources.retire();
      assert.equal(resources.retire(), retirement);
      assert.throws(() => resources.acquire(), { name: 'TargetClosedError' });
      assert.throws(() => resources.acquireArchive(), { name: 'TargetClosedError' });
      await assert.rejects(resources.captureBytes(Buffer.from('late'), signal()), { name: 'TargetClosedError' });
      await retirement;
      await archives[0].dispose();
      await filesystem.access(resource.path);
      const destination = join(directory, 'after-retirement.zip');
      await archives[1].export(destination, signal());
      const zip = new utils.ZipFile(destination);
      try { assert.equal((await zip.read(`resources/${resource.contentHash}`)).toString(), 'shared immutable bytes'); }
      finally { zip.close(); }
      filesystem.rm = async (path, ...arguments_) => {
        if (path === resources.directory) { removalEntered.resolve(); await removalReleased.promise; }
        return originalRemove(path, ...arguments_);
      };
      let disposed = false;
      const disposal = archives[1].dispose().then(() => { disposed = true; });
      await removalEntered.promise;
      assert.equal(disposed, false);
      await filesystem.access(resource.path);
      removalReleased.resolve(); await disposal;
      await assert.rejects(filesystem.access(resources.directory), { code: 'ENOENT' });
    } finally {
      removalReleased.resolve(); filesystem.rm = originalRemove;
      for (const archive of archives) await archive.dispose();
      for (const writer of writers) await writer.dispose();
      await resources.dispose();
    }
  });

  await check('retirement waits for an active writer without making earlier archive disposal wait on it', async () => {
    const resources = await TraceResources.create();
    const sealedWriter = await TraceWriter.create(resources);
    const activeWriter = await TraceWriter.create(resources);
    const archive = await sealedWriter.takeArchive(signal());
    const originalRemove = filesystem.rm;
    const removalEntered = deferred(); const removalReleased = deferred();
    filesystem.rm = async (path, ...arguments_) => {
      if (path === resources.directory) { removalEntered.resolve(); await removalReleased.promise; }
      return originalRemove(path, ...arguments_);
    };
    let retired = false;
    const retirement = resources.retire().then(() => { retired = true; });
    try {
      await archive.dispose();
      assert.equal(retired, false);
      await activeWriter.dispose();
      await removalEntered.promise;
      assert.equal(retired, false);
      removalReleased.resolve(); await retirement;
      await assert.rejects(filesystem.access(resources.directory), { code: 'ENOENT' });
    } finally {
      removalReleased.resolve(); filesystem.rm = originalRemove;
      await archive.dispose(); await sealedWriter.dispose(); await activeWriter.dispose(); await resources.dispose();
    }
  });

  await check('an in-flight ingest retains retirement ownership after the last archive leaves', async () => {
    const resources = await TraceResources.create(); const writer = await TraceWriter.create(resources);
    const archive = await writer.takeArchive(signal());
    const originalOpen = filesystem.open;
    const entered = deferred(); const released = deferred();
    filesystem.open = async (path, ...arguments_) => {
      const handle = await originalOpen(path, ...arguments_);
      if (!String(path).startsWith(resources.directory)) return handle;
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => { entered.resolve(); await released.promise; return write(...values); };
      return handle;
    };
    const ingestion = assert.rejects(resources.captureBytes(Buffer.from('pending ingest'), signal()), { name: 'TargetClosedError' });
    let retirement;
    try {
      await entered.promise;
      let retired = false;
      retirement = resources.retire().then(() => { retired = true; });
      await archive.dispose();
      assert.equal(retired, false);
      await filesystem.access(resources.directory);
      released.resolve(); await ingestion; await retirement;
      await assert.rejects(filesystem.access(resources.directory), { code: 'ENOENT' });
    } finally {
      released.resolve(); filesystem.open = originalOpen;
      await ingestion; await archive.dispose(); await writer.dispose(); await retirement; await resources.dispose();
    }
  });

  await check('retirement before handoff cannot transfer an archive or strand the active writer lease', async () => {
    const resources = await TraceResources.create(); const writer = await TraceWriter.create(resources);
    writer.append({ original: true });
    const retirement = resources.retire();
    try {
      await assert.rejects(writer.takeArchive(signal()), { name: 'TargetClosedError' });
      await writer.dispose(); await retirement;
      await assert.rejects(filesystem.access(resources.directory), { code: 'ENOENT' });
    } finally { await writer.dispose(); await resources.dispose(); }
  });

  await check('the last archive exposes resource cleanup failure without replacing an earlier stream failure', async () => {
    for (const failStream of [false, true]) {
      const resources = await TraceResources.create(); const writer = await TraceWriter.create(resources);
      const archive = await writer.takeArchive(signal());
      const originalRemove = filesystem.rm;
      const streamError = new Error('original stream cleanup failure');
      const resourceError = new Error('resource cleanup failure');
      await resources.retire();
      filesystem.rm = async (path, ...arguments_) => {
        if (failStream && path === writer.directory) throw streamError;
        if (path === resources.directory) throw resourceError;
        return originalRemove(path, ...arguments_);
      };
      try {
        const disposal = archive.dispose();
        assert.equal(archive.dispose(), disposal);
        await assert.rejects(disposal, error => error === (failStream ? streamError : resourceError));
        await assert.rejects(resources.dispose(), error => error === resourceError);
        await assert.rejects(writer.dispose(), error => error === (failStream ? streamError : resourceError));
      } finally {
        filesystem.rm = originalRemove;
        await archive.dispose().catch(() => {}); await writer.dispose().catch(() => {}); await resources.dispose().catch(() => {});
        await filesystem.rm(writer.directory, { recursive: true, force: true });
        await filesystem.rm(resources.directory, { recursive: true, force: true });
      }
    }
  });

  await check('transferred manifests retain streams and resources after writer disposal', () => fixture(async ({ resources, writer, seal }) => {
    writer.append({ type: 'before', callId: 'original' });
    await writer.appendNetwork({ type: 'resource-snapshot', value: 'original' }, signal());
    const resource = await resources.captureBytes(Buffer.from('original resource'), signal());
    writer.addResource(`resources/${resource.contentHash}`, resource);
    const archive = await seal();
    await writer.dispose();
    const reader = archive.acquire();
    try {
      assert(Object.isFrozen(reader.entries));
      assert(reader.entries.every(Object.isFrozen));
      for (const entry of reader.entries) assert.equal(hash(entry.path ? await filesystem.readFile(entry.path) : Buffer.alloc(0)), entry.contentHash);
    } finally { reader.release(); reader.release(); }
    const path = join(directory, 'transferred.zip');
    await archive.export(path, signal());
    const zip = new utils.ZipFile(path);
    try {
      assert.equal(JSON.parse((await zip.read('trace.trace')).toString()).callId, 'original');
      assert.equal(JSON.parse((await zip.read('trace.network')).toString()).value, 'original');
      assert.equal((await zip.read(`resources/${resource.contentHash}`)).toString(), 'original resource');
    } finally { zip.close(); }
    let released = false;
    const resourceDisposal = resources.dispose().then(() => { released = true; });
    await Promise.resolve(); assert.equal(released, false);
    await archive.dispose(); await resourceDisposal;
    await assert.rejects(filesystem.access(writer.directory), { code: 'ENOENT' });
    await assert.rejects(filesystem.access(resources.directory), { code: 'ENOENT' });
  }));

  await check('manifest disposal closes admission and waits for its original reader', () => fixture(async ({ writer, seal }) => {
    writer.append({ value: 'held' });
    const archive = await seal();
    const reader = archive.acquire();
    try {
      assert.throws(() => archive.acquire(), { name: 'ResourceLimitError' });
      let disposed = false;
      const disposal = archive.dispose();
      assert.equal(archive.dispose(), disposal);
      void disposal.then(() => { disposed = true; });
      assert.throws(() => archive.acquire(), { name: 'TargetClosedError' });
      await Promise.resolve(); assert.equal(disposed, false);
      await filesystem.access(writer.directory);
      reader.release(); await disposal;
      await assert.rejects(filesystem.access(writer.directory), { code: 'ENOENT' });
    } finally { reader.release(); }
  }));

  await check('disposal or cancellation during source capture cannot publish a late manifest', async () => {
    for (const mode of ['dispose', 'cancel']) await fixture(async ({ resources, writer }) => {
      const entered = deferred(); const release = deferred(); const cancellation = new AbortController();
      const source = join(directory, `source-${mode}.ts`); await filesystem.writeFile(source, 'export const value = 42;');
      writer.referenceSources([{ file: source }]);
      const originalCapture = resources.captureFile.bind(resources);
      resources.captureFile = async (...arguments_) => { entered.resolve(); await release.promise; return originalCapture(...arguments_); };
      const original = new Error('cancel original preparation');
      const rejected = assert.rejects(writer.takeArchive(cancellation.signal), error => mode === 'cancel' ? error === original : error.name === 'TargetClosedError');
      try {
        await entered.promise;
        if (mode === 'cancel') cancellation.abort(original);
        let disposed = false; const disposal = writer.dispose().then(() => { disposed = true; });
        await Promise.resolve(); assert.equal(disposed, false);
        release.resolve(); await rejected; await disposal;
        await assert.rejects(filesystem.access(writer.directory), { code: 'ENOENT' });
      } finally { release.resolve(); await rejected; }
    });
  });

  await check('a second handoff rejects without invalidating the original manifest', () => fixture(async ({ writer, seal }) => {
    writer.append({ value: 1 });
    const archive = await seal();
    await assert.rejects(writer.takeArchive(signal()), { name: 'ProtocolError' });
    await archive.export(join(directory, 'single-transfer.zip'), signal());
  }));

  await check('same-length stream replacement fails export and preserves prior output', async () => {
    for (const name of ['trace.trace', 'trace.network']) await fixture(async ({ writer, seal }) => {
      writer.append({ value: 'a' });
      await writer.appendNetwork({ value: 'a' }, signal());
      const archive = await seal(); const reader = archive.acquire();
      const entry = reader.entries.find(entry => entry.name === name); reader.release();
      const original = await filesystem.readFile(entry.path, 'utf8');
      await filesystem.writeFile(entry.path, original.replace('a', 'b'));
      const destination = join(directory, `changed-${name}.zip`); await filesystem.writeFile(destination, 'preserved');
      await assert.rejects(archive.export(destination, signal()), { name: 'ProtocolError' });
      assert.equal(await filesystem.readFile(destination, 'utf8'), 'preserved');
    });
  });

  await check('cancelled export retains custody through an already pending write and cleanup', async () => {
    for (const blockedWrite of [1, 2]) await fixture(async ({ writer, seal }) => {
      writer.append({ value: 1 }); const archive = await seal();
      const entered = deferred(); const release = deferred(); const cancellation = new AbortController();
      const destination = join(directory, 'cancelled.zip'); await filesystem.writeFile(destination, 'preserved');
      const originalOpen = filesystem.open; let writes = 0;
      filesystem.open = async (path, ...arguments_) => {
        const handle = await originalOpen(path, ...arguments_);
        if (!String(path).startsWith(`${destination}.`)) return handle;
        const originalWrite = handle.writeFile.bind(handle);
        handle.writeFile = async (...values) => { if (++writes === blockedWrite) { entered.resolve(); await release.promise; } return originalWrite(...values); };
        return handle;
      };
      const original = new Error('original export cancellation');
      const rejected = assert.rejects(archive.export(destination, cancellation.signal), error => error === original);
      try {
        await entered.promise; cancellation.abort(original);
        let disposed = false; const disposal = archive.dispose().then(() => { disposed = true; });
        await writer.dispose(); await Promise.resolve(); assert.equal(disposed, false);
        await filesystem.access(writer.directory);
        release.resolve(); await rejected; await disposal;
        assert.equal(await filesystem.readFile(destination, 'utf8'), 'preserved');
        assert(!(await filesystem.readdir(directory)).some(name => name.startsWith('cancelled.zip.')));
      } finally { release.resolve(); filesystem.open = originalOpen; await rejected; }
    });
  });

  await check('cancellation does not replace an independent pending write failure', () => fixture(async ({ writer, seal }) => {
    writer.append({ value: 1 }); const archive = await seal();
    const entered = deferred(); const release = deferred(); const cancellation = new AbortController();
    const destination = join(directory, 'independent-error.zip'); await filesystem.writeFile(destination, 'preserved');
    const originalOpen = filesystem.open; const originalFailure = new Error('independent write failure'); let writes = 0;
    filesystem.open = async (path, ...arguments_) => {
      const handle = await originalOpen(path, ...arguments_);
      if (!String(path).startsWith(`${destination}.`)) return handle;
      const originalWrite = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => {
        if (++writes === 2) { entered.resolve(); await release.promise; throw originalFailure; }
        return originalWrite(...values);
      };
      return handle;
    };
    const rejected = assert.rejects(archive.export(destination, cancellation.signal), error => error === originalFailure);
    try {
      await entered.promise; cancellation.abort(new Error('separate cancellation'));
      release.resolve(); await rejected;
      assert.equal(await filesystem.readFile(destination, 'utf8'), 'preserved');
    } finally { release.resolve(); filesystem.open = originalOpen; await rejected; }
  }));

  await check('dispatched atomic commit retains custody and awaits its definitive outcome', () => fixture(async ({ writer, seal }) => {
    writer.append({ value: 'committed' }); const archive = await seal();
    const entered = deferred(); const release = deferred(); const cancellation = new AbortController();
    const destination = join(directory, 'committed.zip'); await filesystem.writeFile(destination, 'preserved');
    const originalRename = filesystem.rename; let committing = false;
    filesystem.rename = async (source, target) => { if (target === destination) { entered.resolve(); await release.promise; } return originalRename(source, target); };
    const exportWork = archive.export(destination, cancellation.signal, () => { committing = true; });
    try {
      await entered.promise; assert.equal(committing, true); cancellation.abort(new Error('late cancellation'));
      let disposed = false; const disposal = archive.dispose().then(() => { disposed = true; });
      await Promise.resolve(); assert.equal(disposed, false);
      release.resolve(); await exportWork; await disposal;
      assert.equal((await filesystem.readFile(destination)).readUInt32LE(0), 0x04034b50);
    } finally { release.resolve(); filesystem.rename = originalRename; await exportWork; }
  }));

  await check('invalid, duplicate and oversized manifests reject before accepting cleanup ownership', async () => {
    const empty = { name: 'test.trace', byteLength: 0, contentHash: hash('') };
    let cleaned = false; const cleanup = async () => { cleaned = true; };
    for (const entries of [[empty, empty], [{ ...empty, name: '../escape' }], [{ ...empty, byteLength: -1 }], [{ ...empty, contentHash: 'invalid' }], [{ ...empty, byteLength: 1 }]]) {
      assert.throws(() => new SealedTraceArchive(entries, cleanup), { name: 'ProtocolError' });
    }
    assert.throws(() => new SealedTraceArchive([{ ...empty, path: 'owned', byteLength: 512 * 1024 * 1024 }], cleanup), { name: 'ResourceLimitError' });
    assert.throws(() => new SealedTraceArchive(Array(8195).fill(empty), cleanup), { name: 'ResourceLimitError' });
    assert.equal(cleaned, false);
    const mutable = { ...empty }; const archive = new SealedTraceArchive([mutable], cleanup); mutable.name = '../changed';
    const reader = archive.acquire(); assert.equal(reader.entries[0].name, 'test.trace'); reader.release();
    await archive.dispose(); assert.equal(cleaned, true);
  });

  await check('cleanup reentry cannot acquire a new reader after disposal starts', async () => {
    let archive;
    archive = new SealedTraceArchive([], async () => {
      assert.throws(() => archive.acquire(), { name: 'TargetClosedError' });
    });
    await archive.dispose();
  });

  await check('manual export preserves its original failure and still exposes cleanup failure', async () => {
    const resources = await TraceResources.create(); const writer = await TraceWriter.create(resources);
    const originalOpen = filesystem.open; const originalRemove = filesystem.rm;
    const exportError = new Error('original export failure'); const cleanupError = new Error('independent cleanup failure');
    const destination = join(directory, 'failed-cleanup.zip'); await filesystem.writeFile(destination, 'preserved');
    filesystem.open = async (path, ...arguments_) => {
      if (String(path).startsWith(`${destination}.`)) throw exportError;
      return originalOpen(path, ...arguments_);
    };
    filesystem.rm = async (path, ...arguments_) => {
      if (path === writer.directory) throw cleanupError;
      return originalRemove(path, ...arguments_);
    };
    try {
      writer.append({ value: 'original' });
      await assert.rejects(writer.finish(destination, signal()), error => error === exportError);
      await assert.rejects(writer.dispose(), error => error === cleanupError);
      assert.equal(await filesystem.readFile(destination, 'utf8'), 'preserved');
    } finally {
      filesystem.open = originalOpen; filesystem.rm = originalRemove;
      await writer.dispose().catch(() => {});
      await filesystem.rm(writer.directory, { recursive: true, force: true });
      await resources.dispose();
    }
  });

  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await filesystem.rm(directory, { recursive: true, force: true });
  if (process.env.FLASHWRIGHT_REPORT_PATH) await filesystem.writeFile(process.env.FLASHWRIGHT_REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
