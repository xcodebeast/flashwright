import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { TraceStorageBudget } = require('../packages/flashwright-core/dist/commonjs/trace-storage-budget.js');
const { TraceResources } = require('../packages/flashwright-core/dist/commonjs/trace-resources.js');
const { TraceWriter } = require('../packages/flashwright-core/dist/commonjs/trace-writer.js');
const { RunnerTraceJournal } = require('../packages/flashwright-core/dist/commonjs/runner-trace-journal.js');
const { SealedTraceArchive } = require('../packages/flashwright-core/dist/commonjs/trace-archive.js');
const { TraceArchiveAssembly } = require('../packages/flashwright-core/dist/commonjs/trace-archive-assembly.js');
const directory = await filesystem.mkdtemp(join(tmpdir(), 'flashwright-storage-budget-tests-'));
const report = { status: 'running', checks: [] };
const signal = () => new AbortController().signal;
const limits = overrides => new TraceStorageBudget({ bytes: 4096, files: 32, owners: 16, queuedBytes: 4096, ...overrides });
const context = () => ({ version: 8, type: 'context-options', origin: 'testRunner', options: {}, monotonicTime: 1, wallTime: 1 });
const options = { sources: false, attachments: true };
const deferred = () => { let resolve; const promise = new Promise(complete => { resolve = complete; }); return { promise, resolve }; };
async function check(name, work) { await work(); report.checks.push(name); }
async function fixtureArchive(budget, name) {
  const path = join(directory, name);
  const bytes = Buffer.from('original stream');
  await filesystem.writeFile(path, bytes);
  return new SealedTraceArchive([{ name: 'test.trace', path, byteLength: bytes.length, contentHash: createHash('sha256').update(bytes).digest('hex') }], async () => {}, budget);
}

try {
  await check('separate recordings compete before writing and retired archive custody keeps its original credit', async () => {
    const budget = limits({ bytes: 12 });
    const first = await TraceResources.create(budget);
    const second = await TraceResources.create(budget);
    const release = first.acquireArchive();
    try {
      await first.captureBytes(Buffer.from('12345678'), signal());
      await first.retire();
      await assert.rejects(second.captureBytes(Buffer.from('abcde'), signal()), { name: 'ResourceLimitError' });
      assert.deepEqual(await filesystem.readdir(second.directory), []);
      await release();
      const resource = await second.captureBytes(Buffer.from('abcde'), signal());
      assert.equal((await filesystem.readFile(resource.path)).toString(), 'abcde');
    } finally { await release(); await first.dispose(); await second.dispose(); }
    assert.equal(budget.bytes, 0);
    assert.equal(budget.owners, 0);
  });

  await check('duplicate temporary bytes remain charged while deletion is blocked', async () => {
    const budget = limits({ bytes: 8 });
    const resources = await TraceResources.create(budget);
    const successor = await TraceResources.create(budget);
    const original = filesystem.rm; const entered = deferred(); const release = deferred();
    let pending;
    try {
      const first = await resources.captureBytes(Buffer.from('same'), signal());
      filesystem.rm = async (path, ...rest) => {
        if (String(path).startsWith(resources.directory) && String(path).endsWith('.tmp')) { entered.resolve(); await release.promise; }
        return original(path, ...rest);
      };
      pending = resources.captureBytes(Buffer.from('same'), signal());
      await entered.promise;
      await assert.rejects(successor.captureBytes(Buffer.from('x'), signal()), { name: 'ResourceLimitError' });
      assert.equal(budget.bytes, 8);
      release.resolve();
      assert.equal(await pending, first);
      assert.equal(budget.bytes, 4);
      await successor.captureBytes(Buffer.from('more'), signal());
    } finally { release.resolve(); filesystem.rm = original; await pending?.catch(() => {}); await resources.dispose(); await successor.dispose(); }
  });

  await check('failed duplicate removal keeps byte and file credit until whole-store removal succeeds', async () => {
    const budget = limits({ bytes: 8 });
    const resources = await TraceResources.create(budget);
    const successor = await TraceResources.create(budget);
    const original = filesystem.rm;
    try {
      await resources.captureBytes(Buffer.from('same'), signal());
      filesystem.rm = async (path, ...rest) => {
        if (String(path).startsWith(resources.directory) && String(path).endsWith('.tmp')) throw Error('duplicate removal failed');
        return original(path, ...rest);
      };
      await assert.rejects(resources.captureBytes(Buffer.from('same'), signal()), /duplicate removal failed/);
      assert.equal(resources.bytes, 8);
      assert.equal(budget.files, 2);
      await assert.rejects(successor.captureBytes(Buffer.from('x'), signal()), { name: 'ResourceLimitError' });
      filesystem.rm = original;
      await resources.dispose();
      await successor.captureBytes(Buffer.from('12345678'), signal());
    } finally { filesystem.rm = original; await resources.dispose(); await successor.dispose(); }
  });

  await check('pending and failed directory cleanup deny successor owners before filesystem allocation', async () => {
    const budget = limits({ owners: 1 });
    const resources = await TraceResources.create(budget);
    const original = filesystem.rm; const entered = deferred(); const release = deferred();
    let disposal;
    try {
      filesystem.rm = async (path, ...rest) => {
        if (path === resources.directory) { entered.resolve(); await release.promise; throw Error('directory removal failed'); }
        return original(path, ...rest);
      };
      disposal = resources.dispose(); const rejection = assert.rejects(disposal, /directory removal failed/);
      await entered.promise;
      await assert.rejects(TraceResources.create(budget), { name: 'ResourceLimitError' });
      release.resolve(); await rejection;
      await assert.rejects(TraceResources.create(budget), { name: 'ResourceLimitError' });
      await filesystem.access(resources.directory);
    } finally { release.resolve(); filesystem.rm = original; await disposal?.catch(() => {}); await original(resources.directory, { recursive: true, force: true }); }
  });

  await check('an original ingest failure survives failed cleanup while its partial file remains charged', async () => {
    const budget = limits({ bytes: 4 });
    const resources = await TraceResources.create(budget);
    const originalOpen = filesystem.open; const originalRemove = filesystem.rm;
    try {
      filesystem.open = async (...parameters) => {
        const handle = await originalOpen(...parameters);
        if (String(parameters[0]).startsWith(resources.directory)) {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async bytes => { await write(bytes.subarray(0, 1)); throw Error('original partial write'); };
        }
        return handle;
      };
      filesystem.rm = async (path, ...rest) => {
        if (String(path).startsWith(resources.directory) && String(path).endsWith('.tmp')) throw Error('secondary removal');
        return originalRemove(path, ...rest);
      };
      await assert.rejects(resources.captureBytes(Buffer.from('held'), signal()), /original partial write/);
      assert.equal(budget.bytes, 4);
      assert.equal(resources.bytes, 4);
      const names = await filesystem.readdir(resources.directory);
      assert.equal((await filesystem.readFile(join(resources.directory, names[0]))).toString(), 'h');
    } finally { filesystem.open = originalOpen; filesystem.rm = originalRemove; await resources.dispose(); }
    assert.equal(budget.bytes, 0);
  });

  await check('file ingestion consumes the same budget and releases failed temporary writes without losing another store', async () => {
    const budget = limits({ bytes: 7 });
    const first = await TraceResources.create(budget);
    const second = await TraceResources.create(budget);
    const path = join(directory, 'file-input');
    await filesystem.writeFile(path, '12345');
    try {
      await first.captureFile(path, signal());
      await assert.rejects(second.captureFile(path, signal()), { name: 'ResourceLimitError' });
      assert.equal(budget.bytes, 5);
      assert.equal(budget.files, 1);
      assert.deepEqual(await filesystem.readdir(second.directory), []);
      await first.dispose();
      const captured = await second.captureFile(path, signal());
      assert.equal(await filesystem.readFile(captured.path, 'utf8'), '12345');
    } finally { await first.dispose(); await second.dispose(); }
  });

  await check('private file limits count temporary duplicates and empty streams before opening', async () => {
    const budget = limits({ files: 2 });
    const resources = await TraceResources.create(budget);
    try {
      await resources.captureBytes(Buffer.from('one'), signal());
      await assert.rejects(TraceWriter.create(resources), { name: 'ResourceLimitError' });
      assert.equal(resources.activeLeases, 0);
      await resources.captureBytes(Buffer.from('two'), signal());
      await assert.rejects(resources.captureBytes(Buffer.from('one'), signal()), { name: 'ResourceLimitError' });
      assert.equal((await filesystem.readdir(resources.directory)).length, 2);
    } finally { await resources.dispose(); }
  });

  await check('a sealed stream remains charged after writer and recording retirement until its reader releases', async () => {
    const event = { type: 'test', text: 'retained' };
    const length = Buffer.byteLength(JSON.stringify(event) + '\n');
    const budget = limits({ bytes: length });
    const resources = await TraceResources.create(budget);
    const writer = await TraceWriter.create(resources);
    const successor = await TraceResources.create(budget);
    let archive; let reader;
    try {
      writer.append(event);
      archive = await writer.takeArchive(signal());
      await writer.dispose(); await resources.retire();
      reader = archive.acquire();
      const disposal = archive.dispose();
      await assert.rejects(successor.captureBytes(Buffer.from('x'), signal()), { name: 'ResourceLimitError' });
      reader.release(); await disposal;
      await successor.captureBytes(Buffer.from('x'), signal());
    } finally { reader?.release(); await archive?.dispose(); await writer.dispose(); await resources.dispose(); await successor.dispose(); }
  });

  await check('runner finalization charges intermediate and final streams together', async () => {
    const budget = limits({ bytes: 180 });
    const journal = await RunnerTraceJournal.create(context(), options, budget);
    try {
      journal.append({ type: 'stdout', text: 'x'.repeat(70) });
      assert.equal(journal.failure, undefined);
      await assert.rejects(journal.takeArchive(1000, signal()), { name: 'ResourceLimitError' });
      assert.ok(budget.bytes >= journal.streamBytes);
    } finally { await journal.dispose(); }
    assert.equal(budget.bytes, 0);
    assert.equal(budget.files, 0);
  });

  await check('chunk and early journal write queues share admission before filesystem initialization settles', async () => {
    const event = { type: 'stdout', text: 'shared queue' };
    const length = Buffer.byteLength(JSON.stringify(event) + '\n');
    const budget = limits({ queuedBytes: length });
    const resources = await TraceResources.create(budget);
    const writer = await TraceWriter.create(resources);
    const original = filesystem.open; const entered = deferred(); const release = deferred();
    let journal;
    try {
      filesystem.open = async (...parameters) => {
        const handle = await original(...parameters);
        if (String(parameters[0]).endsWith('events.jsonl')) { entered.resolve(); await release.promise; }
        return handle;
      };
      journal = RunnerTraceJournal.begin(context(), options, budget);
      journal.append(event);
      await entered.promise;
      const retained = budget.bytes;
      writer.append(event);
      assert.equal(writer.failure.name, 'ResourceLimitError');
      assert.equal(journal.failure, undefined);
      assert.equal(budget.queuedBytes, length);
      assert.equal(budget.bytes, retained);
      release.resolve();
      await journal.dispose();
      assert.equal(budget.queuedBytes, 0);
    } finally { release.resolve(); filesystem.open = original; await journal?.dispose(); await writer.dispose(); await resources.dispose(); }
  });

  await check('shared body-copy admission rejects before copying and leaves the original attachment unchanged', async () => {
    const budget = limits({ queuedBytes: 300 });
    const journal = RunnerTraceJournal.begin(context(), options, budget);
    const attachment = Buffer.alloc(512, 7);
    try {
      journal.append({ type: 'after', callId: 'body' }, [{ name: 'body', contentType: 'application/octet-stream', body: attachment }]);
      assert.equal(journal.failure.name, 'ResourceLimitError');
      assert.equal(journal.queuedAttachments, 0);
      assert.equal(budget.queuedBytes, 0);
      assert.equal(budget.bytes, 0);
      assert.deepEqual(attachment, Buffer.alloc(512, 7));
    } finally { await journal.dispose(); }
  });

  await check('ZIP staging reserves complete encoded output before opening or replacing the destination', async () => {
    const budget = limits({ bytes: 1 });
    const archive = await fixtureArchive(budget, 'quota-input');
    const destination = join(directory, 'quota.zip');
    await filesystem.writeFile(destination, 'preserved');
    try {
      await assert.rejects(archive.export(destination, signal()), { name: 'ResourceLimitError' });
      assert.equal(await filesystem.readFile(destination, 'utf8'), 'preserved');
      assert.equal(budget.bytes, 0);
      assert.equal(budget.owners, 0);
    } finally { await archive.dispose(); }
  });

  await check('definitive rename retains ZIP credit through cancellation and transfers it only after completion', async () => {
    const budget = limits({ owners: 1 });
    const archive = await fixtureArchive(budget, 'rename-input');
    const original = filesystem.rename; const entered = deferred(); const release = deferred();
    const controller = new AbortController(); const destination = join(directory, 'renamed.zip');
    let work;
    try {
      filesystem.rename = async (...parameters) => { entered.resolve(); await release.promise; return original(...parameters); };
      work = archive.export(destination, controller.signal);
      await entered.promise;
      controller.abort(Error('cancel after commit dispatch'));
      await assert.rejects(TraceResources.create(budget), { name: 'ResourceLimitError' });
      assert.ok(budget.bytes > 0);
      release.resolve(); await work;
      assert.equal(budget.bytes, 0);
      const successor = await TraceResources.create(budget); await successor.dispose();
      assert.equal((await filesystem.readFile(destination)).readUInt32LE(0), 0x04034b50);
    } finally { release.resolve(); filesystem.rename = original; await work?.catch(() => {}); await archive.dispose(); }
  });

  await check('failed ZIP removal retains the entire staging reservation and original export failure', async () => {
    const budget = limits({ owners: 1 });
    const archive = await fixtureArchive(budget, 'failed-export-input');
    const original = filesystem.rm; const destination = join(directory, 'failed.zip');
    try {
      filesystem.rm = async (path, ...rest) => {
        if (String(path).startsWith(destination)) throw Error('staging removal failed');
        return original(path, ...rest);
      };
      await assert.rejects(archive.export(destination, signal(), () => { throw Error('original commit rejection'); }), /original commit rejection/);
      await assert.rejects(TraceResources.create(budget), { name: 'ResourceLimitError' });
      assert.ok(budget.bytes > 0);
      assert.equal(budget.queuedBytes, 0);
    } finally { filesystem.rm = original; await archive.dispose(); }
  });

  await check('an unconfirmed resource handle close keeps custody even when its pathname was removed', async () => {
    const budget = limits({ bytes: 4 });
    const resources = await TraceResources.create(budget);
    const original = filesystem.open; let actualClose;
    try {
      filesystem.open = async (...parameters) => {
        const handle = await original(...parameters);
        if (String(parameters[0]).startsWith(resources.directory)) {
          actualClose = handle.close.bind(handle);
          handle.close = async () => { throw Error('handle closure uncertain'); };
        }
        return handle;
      };
      await assert.rejects(resources.captureBytes(Buffer.from('held'), signal()), /handle closure uncertain/);
      await assert.rejects(resources.dispose(), /handle closure uncertain/);
      assert.equal(budget.bytes, 4);
      assert.deepEqual(await filesystem.readdir(resources.directory), []);
      const successor = await TraceResources.create(budget);
      try { await assert.rejects(successor.captureBytes(Buffer.from('x'), signal()), { name: 'ResourceLimitError' }); }
      finally { await successor.dispose(); }
    } finally { filesystem.open = original; await actualClose?.(); await resources.dispose().catch(() => {}); await filesystem.rm(resources.directory, { recursive: true, force: true }); }
  });

  await check('unconfirmed source closure quarantines future ingestion and its owner even without a private resource file', async () => {
    const budget = limits({ owners: 1 });
    const resources = await TraceResources.create(budget);
    const original = filesystem.open; let actualClose; let openings = 0;
    try {
      filesystem.open = async (...parameters) => {
        const handle = await original(...parameters);
        if (parameters[0] === directory) {
          openings++;
          actualClose = handle.close.bind(handle);
          handle.close = async () => { throw Error('source closure uncertain'); };
        }
        return handle;
      };
      await assert.rejects(resources.captureFile(directory, signal()), /source closure uncertain/);
      await assert.rejects(resources.captureFile(directory, signal()), { name: 'TargetClosedError' });
      assert.throws(() => resources.acquire(), { name: 'TargetClosedError' });
      assert.throws(() => resources.acquireArchive(), { name: 'TargetClosedError' });
      assert.equal(openings, 1);
      assert.equal(budget.bytes, 0);
      assert.equal(budget.files, 0);
      await assert.rejects(resources.dispose(), /source closure uncertain/);
      await assert.rejects(TraceResources.create(budget), { name: 'ResourceLimitError' });
    } finally { filesystem.open = original; await actualClose?.(); await resources.dispose().catch(() => {}); await filesystem.rm(resources.directory, { recursive: true, force: true }); }
  });

  await check('failed private journal hashing close retains its resource and original handle through disposal', async () => {
    const budget = limits();
    const journal = await RunnerTraceJournal.create(context(), options, budget);
    const resources = journal.resources;
    const path = join(directory, 'hash-source');
    await filesystem.writeFile(path, 'hash');
    const original = filesystem.open; let actualClose;
    try {
      filesystem.open = async (...parameters) => {
        const handle = await original(...parameters);
        if (String(parameters[0]).startsWith(resources.directory) && parameters[1] === 'r') {
          actualClose = handle.close.bind(handle);
          handle.close = async () => { throw Error('private hash reader close failed'); };
        }
        return handle;
      };
      journal.append({ type: 'after', callId: 'hash' }, [{ name: 'file', contentType: 'text/plain', path }]);
      await assert.rejects(journal.takeArchive(1, signal()), /private hash reader close failed/);
      await assert.rejects(journal.dispose(), /private hash reader close failed/);
      assert.equal(budget.bytes, 4);
      assert.equal(budget.owners, 1);
      assert.equal((await filesystem.readdir(resources.directory)).length, 1);
    } finally { filesystem.open = original; await actualClose?.(); await journal.dispose().catch(() => {}); await filesystem.rm(resources.directory, { recursive: true, force: true }); }
  });

  await check('an unconfirmed assembled ZIP input close keeps every original manifest lease and resource owner', async () => {
    const budget = limits();
    const resources = await TraceResources.create(budget);
    const writer = await TraceWriter.create(resources);
    writer.append({ type: 'test', text: 'retained reader' });
    const originalArchive = await writer.takeArchive(signal());
    const assembly = new TraceArchiveAssembly();
    assembly.addLibrary(originalArchive);
    const archive = assembly.seal();
    await resources.retire();
    const original = filesystem.open; let actualClose;
    const retained = budget.bytes;
    try {
      filesystem.open = async (...parameters) => {
        const handle = await original(...parameters);
        if (parameters[0] === join(writer.directory, 'trace.trace') && parameters[1] === 'r') {
          actualClose = handle.close.bind(handle);
          handle.close = async () => { throw Error('private ZIP reader close failed'); };
        }
        return handle;
      };
      await assert.rejects(archive.export(join(directory, 'reader-failed.zip'), signal()), /private ZIP reader close failed/);
      assert.throws(() => archive.acquire(), { name: 'TargetClosedError' });
      await assert.rejects(archive.dispose(), /private ZIP reader close failed/);
      assert.throws(() => originalArchive.acquire(), { name: 'ResourceLimitError' });
      assert.equal(budget.bytes, retained);
      assert.equal(budget.owners, 2);
      await filesystem.access(join(writer.directory, 'trace.trace'));
    } finally {
      filesystem.open = original; await actualClose?.(); await writer.dispose();
      await filesystem.rm(writer.directory, { recursive: true, force: true });
      await filesystem.rm(resources.directory, { recursive: true, force: true });
    }
  });

  await check('disposal retries the exact failed private reader and returns credit only after confirmed closure', async () => {
    const budget = limits();
    const resources = await TraceResources.create(budget);
    const writer = await TraceWriter.create(resources);
    writer.append({ type: 'test', text: 'retry close' });
    const archive = await writer.takeArchive(signal());
    await resources.retire();
    const original = filesystem.open; const entered = deferred(); const release = deferred();
    let disposal;
    try {
      filesystem.open = async (...parameters) => {
        const handle = await original(...parameters);
        if (parameters[0] === join(writer.directory, 'trace.trace') && parameters[1] === 'r') {
          const close = handle.close.bind(handle); let calls = 0;
          handle.close = async () => {
            if (++calls === 1) throw Error('first close failed');
            entered.resolve(); await release.promise; return close();
          };
        }
        return handle;
      };
      await assert.rejects(archive.export(join(directory, 'retry-reader.zip'), signal()), /first close failed/);
      disposal = archive.dispose();
      await entered.promise;
      assert.ok(budget.bytes > 0);
      await filesystem.access(join(writer.directory, 'trace.trace'));
      release.resolve(); await disposal;
      assert.equal(budget.bytes, 0);
      assert.equal(budget.owners, 0);
    } finally { release.resolve(); filesystem.open = original; await disposal; await writer.dispose(); await resources.dispose(); }
  });
  report.status = 'passed';
} finally {
  await filesystem.rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
