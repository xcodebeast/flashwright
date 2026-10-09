import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { RunnerTraceJournal } = require('../packages/flashwright-core/dist/commonjs/runner-trace-journal.js');
const { snapshotRunnerRecord, encodeRunnerRecord } = require('../packages/flashwright-core/dist/commonjs/runner-trace-record.js');
const { TraceResources } = require('../packages/flashwright-core/dist/commonjs/trace-resources.js');
const { runnerIntegration } = require('../packages/flashwright-core/dist/commonjs/runner-integration.js');
const { utils, iso } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const directory = await filesystem.mkdtemp(join(tmpdir(), 'flashwright-journal-tests-'));
const report = { status: 'running', checks: [] };
const exported = [];
const signal = () => new AbortController().signal;
const hash = (value, algorithm = 'sha1') => createHash(algorithm).update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(complete => { resolve = complete; }); return { promise, resolve }; };
const context = () => ({ version: 8, type: 'context-options', origin: 'testRunner', browserName: '', playwrightVersion: '1.60.0', options: {}, platform: process.platform, wallTime: 1234567, monotonicTime: 12, sdkLanguage: 'javascript' });
const after = callId => ({ type: 'after', callId, endTime: 99 });
const body = (name, content) => ({ name, contentType: 'application/octet-stream', body: Buffer.from(content) });
let nextArchive = 0;
async function check(name, callback) { await callback(); report.checks.push(name); }
async function journal(callback, options = { sources: true, attachments: true }) {
  const value = await RunnerTraceJournal.create(context(), options);
  try { await callback(value); } finally { await value.dispose(); }
}
async function readArchive(journal, timeout = 12345) {
  const archive = await journal.takeArchive(timeout, signal());
  try {
    const path = join(directory, `trace-${++nextArchive}.zip`);
    await archive.export(path, signal()); exported.push(path);
    const zip = new utils.ZipFile(path);
    try {
      const names = await zip.entries();
      const contents = Object.fromEntries(await Promise.all(names.map(async name => [name, await zip.read(name)])));
      const records = contents['test.trace'].toString().trimEnd().split('\n').map(line => JSON.parse(line));
      return { names, contents, records, path };
    } finally { zip.close(); }
  } finally { await archive.dispose(); }
}

try {
  await check('journal factory enforces its private version without exposing a public constructor', async () => {
    assert.equal(runnerIntegration.version, 9);
    assert.throws(() => runnerIntegration.createTraceJournal(4, context(), { sources: false, attachments: false }), { name: 'ProtocolError' });
    assert.equal('RunnerTraceJournal' in require('../packages/flashwright-core/dist/commonjs/index.js'), false);
    const value = await runnerIntegration.createTraceJournal(5, context(), { sources: false, attachments: false });
    await value.dispose();
    assert.throws(() => runnerIntegration.beginTraceJournal(5, context(), { sources: false, attachments: false }), { name: 'ProtocolError' });
    const starting = runnerIntegration.beginTraceJournal(6, context(), { sources: false, attachments: false });
    assert.equal(typeof starting.then, 'undefined');
    await starting.dispose();
  });

  await check('synchronous admission snapshots records and bodies while filesystem initialization is blocked', async () => {
    const entered = deferred(); const release = deferred(); const original = TraceResources.create;
    TraceResources.create = async () => { const resources = await original.call(TraceResources); entered.resolve(); await release.promise; return resources; };
    let value;
    try {
      value = RunnerTraceJournal.begin(context(), { sources: false, attachments: true });
      const attachment = body('early', 'before initialization');
      value.append(after('early'), [attachment]);
      attachment.body.fill(120);
      assert.equal(value.queuedAttachments, 1);
      assert.equal(value.queuedAttachmentBytes, Buffer.byteLength('before initialization'));
      await entered.promise;
      assert.equal(value.file, undefined);
      const pending = readArchive(value);
      release.resolve();
      const result = await pending;
      assert.equal(result.contents[`resources/${hash('before initialization')}`].toString(), 'before initialization');
    } finally { release.resolve(); TraceResources.create = original; await value?.dispose(); }
  });

  await check('pre-initialization queues fail at the same admission limits and retain cleanup until creation settles', async () => {
    const entered = deferred(); const release = deferred(); const original = TraceResources.create;
    let resourceDirectory;
    TraceResources.create = async () => { const resources = await original.call(TraceResources); resourceDirectory = resources.directory; entered.resolve(); await release.promise; return resources; };
    let value;
    try {
      value = RunnerTraceJournal.begin(context(), { sources: false, attachments: true });
      const input = body('queued', 'q');
      for (let index = 0; index < 129; index++) value.append(after(`before-open-${index}`), [input]);
      assert.equal(value.failure.name, 'ResourceLimitError'); assert.equal(value.queuedAttachments, 128);
      await entered.promise;
      let disposed = false; const disposal = value.dispose().then(() => { disposed = true; });
      await Promise.resolve(); assert.equal(disposed, false); assert.equal(value.queuedAttachments, 128);
      release.resolve(); await disposal;
      assert.equal(value.queuedAttachments, 0); assert.equal(value.queuedBytes, 0);
      assert.equal(value.file, undefined);
      await assert.rejects(filesystem.access(resourceDirectory), { code: 'ENOENT' });
    } finally { release.resolve(); TraceResources.create = original; await value?.dispose(); }
  });

  await check('initialization failure preserves its original error and cleans resources for both factory forms', async () => {
    const original = filesystem.mkdtemp; const resourcesCreated = [];
    filesystem.mkdtemp = async (...parameters) => {
      if (String(parameters[0]).includes('flashwright-runner-trace-')) throw Error('original journal directory failure');
      const directory = await original(...parameters);
      if (String(parameters[0]).includes('flashwright-trace-resources-')) resourcesCreated.push(directory);
      return directory;
    };
    let value;
    try {
      value = RunnerTraceJournal.begin(context(), { sources: false, attachments: true });
      value.append(after('not-open'), [body('queued', 'bytes')]);
      await assert.rejects(value.takeArchive(1, signal()), /original journal directory failure/);
      await value.dispose();
      await assert.rejects(RunnerTraceJournal.create(context(), { sources: false, attachments: false }), /original journal directory failure/);
      assert.equal(resourcesCreated.length, 2);
      for (const directory of resourcesCreated) await assert.rejects(filesystem.access(directory), { code: 'ENOENT' });
    } finally { filesystem.mkdtemp = original; await value?.dispose(); }
  });

  await check('a late original file-open completion stays owned after disposal and cannot enter a successor', async () => {
    const entered = deferred(); const release = deferred(); const original = filesystem.open;
    let file;
    filesystem.open = async (...parameters) => {
      const handle = await original(...parameters);
      if (String(parameters[0]).endsWith('events.jsonl') && !file) { file = handle; entered.resolve(); await release.promise; }
      return handle;
    };
    const value = RunnerTraceJournal.begin(context(), { sources: false, attachments: false });
    let successor;
    try {
      await entered.promise;
      const pending = value.takeArchive(1, signal());
      const rejected = assert.rejects(pending, { name: 'TargetClosedError' });
      let disposed = false; const disposal = value.dispose().then(() => { disposed = true; });
      successor = RunnerTraceJournal.begin(context(), { sources: false, attachments: false });
      successor.append({ type: 'stdout', text: 'successor only' });
      const result = await readArchive(successor);
      assert.equal(result.records[1].text, 'successor only');
      assert.equal(disposed, false);
      release.resolve(); await rejected; await disposal;
      await assert.rejects(file.stat(), { code: 'EBADF' });
      await assert.rejects(filesystem.access(value.directory), { code: 'ENOENT' });
    } finally { release.resolve(); filesystem.open = original; await value.dispose(); await successor?.dispose(); }
  });
  await check('final timeout and original context clocks survive ordered incremental journal replay in the pinned loader', () => journal(async value => {
    const parameters = { expected: 'before mutation' };
    value.append({ type: 'before', callId: 'step@1', stepId: 'step@1', startTime: 20, class: 'Test', method: 'test.step', title: 'journal step', params: parameters, stack: [] });
    parameters.expected = 'after mutation';
    value.appendStdio('stdout', 'hello λ\n', 21);
    value.appendStdio('stderr', Buffer.from([0, 255, 10]), 22);
    value.append(after('step@1'));
    const result = await readArchive(value, 54321);
    assert.deepEqual(result.records[0], { ...context(), testTimeout: 54321 });
    assert.equal(result.records[1].params.expected, 'before mutation');
    assert.deepEqual(result.records.slice(2, 4), [{ type: 'stdout', timestamp: 21, text: 'hello λ\n' }, { type: 'stderr', timestamp: 22, base64: 'AP8K' }]);
    assert.equal(result.records.at(-1).type, 'after');
    const loader = new iso.TraceLoader();
    await loader.load({ entryNames: async () => result.names, readText: async name => result.contents[name]?.toString(), hasEntry: async name => result.names.includes(name), isLive: () => false });
    assert.equal(loader.contextEntries.length, 1);
    assert.equal(loader.contextEntries[0].testTimeout, 54321);
    assert.equal(loader.contextEntries[0].actions[0].title, 'journal step');
  }));

  await check('body attachments snapshot synchronously while file attachments and sources observe final export bytes', () => journal(async value => {
    const path = join(directory, 'mutable-attachment'); const source = join(directory, 'mutable-source.ts');
    await filesystem.writeFile(path, 'old file'); await filesystem.writeFile(source, 'old source');
    const attachment = body('body', 'original body');
    value.append({ type: 'before', callId: 'read', stack: [{ file: source, line: 1, column: 1 }] });
    value.append(after('read'), [attachment, { name: 'file', path, contentType: 'text/plain' }, body('empty', ''), body('trace', 'not embedded'), body('second', 'second body'), body('third', 'third body')]);
    attachment.body.fill(120); attachment.name = 'changed';
    await filesystem.writeFile(path, 'final file'); await filesystem.writeFile(source, 'final source');
    const result = await readArchive(value);
    assert.equal(result.contents[`resources/${hash('original body')}`].toString(), 'original body');
    assert.equal(result.contents[`resources/${hash('final file')}`].toString(), 'final file');
    assert.equal(result.contents[`resources/src@${hash(source)}.txt`].toString(), 'final source');
    const attachments = result.records.at(-1).attachments;
    assert.deepEqual(attachments.map(item => item.name), ['body', 'file', 'empty', 'second', 'third']);
    assert.equal(attachments[0].sha1, hash('original body'));
    assert.equal(attachments[1].path, undefined);
    assert.equal(attachments[2].base64, '');
    assert.equal(result.names.some(name => name.endsWith(hash('not embedded'))), false);
  }));

  await check('runner source UTF-8 decoding matches Buffer decoding across chunk boundaries and preserves binary attachment bytes', () => journal(async value => {
    const bytes = Buffer.concat([Buffer.alloc(65535, 120), Buffer.from([0xf0, 0x9f, 0x98, 0x80, 0xff, 0xc0, 0xe2])]);
    const path = join(directory, 'invalid-utf8.ts'); await filesystem.writeFile(path, bytes);
    value.append({ type: 'before', callId: 'source', stack: [{ file: path }] });
    value.append(after('source'), [{ name: 'raw', path, contentType: 'application/octet-stream' }]);
    const result = await readArchive(value);
    assert.deepEqual(result.contents[`resources/src@${hash(path)}.txt`], Buffer.from(bytes.toString('utf8')));
    assert.deepEqual(result.contents[`resources/${hash(bytes)}`], bytes);
  }));

  await check('disabled attachments and sources never inspect or capture supplied paths and bodies', () => journal(async value => {
    let accessed = 0;
    const attachments = new Proxy([], { get() { accessed++; throw Error('must not read'); } });
    value.append({ type: 'before', callId: 'disabled', stack: [{ file: join(directory, 'absent.ts') }] });
    value.append(after('disabled'), attachments);
    const result = await readArchive(value);
    assert.equal(accessed, 0); assert.deepEqual(result.names, ['test.trace']);
    assert.equal(Object.hasOwn(result.records.at(-1), 'attachments'), false);
  }, { sources: false, attachments: false }));

  await check('missing paths remain unresolved and nonregular files cannot stall runner finalization', () => journal(async value => {
    const missing = join(directory, 'missing'); const fifo = join(directory, 'pipe'); execFileSync('mkfifo', [fifo]);
    value.append(after('paths'), [{ name: 'missing', contentType: 'text/plain', path: missing }, { name: 'pipe', contentType: 'text/plain', path: fifo }]);
    const result = await readArchive(value);
    assert.deepEqual(result.records.at(-1).attachments.map(item => item.path), [missing, fifo]);
    assert.deepEqual(result.names, ['test.trace']);
  }));

  await check('metadata admission never invokes accessors, proxy traps or serialization hooks', async () => {
    for (const kind of ['getter', 'proxy', 'toJSON']) await journal(async value => {
      let accessed = 0;
      const unsafe = kind === 'getter' ? { get text() { accessed++; throw Error('accessor'); } } : kind === 'proxy' ? new Proxy({}, { ownKeys() { accessed++; throw Error('proxy'); } }) : { toJSON() { accessed++; throw Error('serializer'); } };
      value.append({ type: 'error', message: unsafe });
      assert.equal(accessed, 0);
      await assert.rejects(value.takeArchive(1, signal()), { name: 'ProtocolError' });
    });
    const original = { type: 'stdout', text: ['\ud800', 'λ', '😀', '\\"\u0000\b\t\n\f\r', '__proto__'] };
    assert.deepEqual(JSON.parse(encodeRunnerRecord(snapshotRunnerRecord(original)).toString()), original);
    await journal(async value => {
      let accessed = 0;
      const input = Buffer.from([0, 255, 10]);
      Object.defineProperty(input, 'base64Slice', { get() { accessed++; throw Error('caller base64 hook'); } });
      Object.defineProperty(input, 'length', { get() { accessed++; throw Error('caller length getter'); } });
      value.appendStdio('stdout', input, 1);
      const result = await readArchive(value);
      assert.equal(accessed, 0); assert.equal(result.records[1].base64, 'AP8K');
    });
  });

  await check('oversized metadata and binary stdio fail before serialization or body copying', async () => {
    await journal(async value => {
      value.append({ type: 'stdout', text: '\u0000'.repeat(50000) });
      assert.equal(value.failure.name, 'ResourceLimitError'); assert.equal(value.streamBytes, 0);
      await assert.rejects(value.takeArchive(1, signal()), { name: 'ResourceLimitError' });
    });
    await journal(async value => {
      const ignored = Object.fromEntries(Array.from({ length: 6000 }, (_, index) => [String(index), undefined]));
      value.append({ type: 'error', first: ignored, second: ignored });
      assert.equal(value.failure.name, 'ResourceLimitError'); assert.equal(value.streamBytes, 0);
    });
    await journal(async value => {
      value.appendStdio('stdout', Buffer.alloc(256 * 1024), 1);
      assert.equal(value.failure.name, 'ResourceLimitError'); assert.equal(value.streamBytes, 0);
    });
    await journal(async value => {
      value.append(after('large'), [body('huge', Buffer.alloc(16 * 1024 * 1024 + 1))]);
      assert.equal(value.failure.name, 'ResourceLimitError'); assert.equal(value.queuedAttachmentBytes, 0);
    });
  });

  await check('queued body count and bytes are admitted before copying and remain owned through blocked writes', async () => {
    for (const [size, count] of [[1, 128], [16 * 1024 * 1024, 2]]) await journal(async value => {
      const entered = deferred(); const release = deferred();
      const original = TraceResources.prototype.captureBytes;
      TraceResources.prototype.captureBytes = async function(...parameters) { entered.resolve(); await release.promise; return original.apply(this, parameters); };
      try {
        const input = body('queued', Buffer.alloc(size));
        for (let index = 0; index < count; index++) value.append(after(`copy-${index}`), [input]);
        assert.equal(value.failure, undefined); assert.equal(value.queuedAttachments, count); assert.equal(value.queuedAttachmentBytes, size * count);
        await entered.promise;
        value.append(after('overflow'), [input]);
        assert.equal(value.failure.name, 'ResourceLimitError');
        assert.equal(value.queuedAttachmentBytes, size * count);
        let disposed = false;
        const disposal = value.dispose().then(() => { disposed = true; });
        await Promise.resolve(); assert.equal(disposed, false);
        assert.equal(value.queuedAttachmentBytes, size * count);
        release.resolve(); await disposal;
        assert.equal(value.queuedAttachments, 0); assert.equal(value.queuedAttachmentBytes, 0);
        await assert.rejects(filesystem.access(value.directory), { code: 'ENOENT' });
      } finally { release.resolve(); TraceResources.prototype.captureBytes = original; }
    });
  });

  await check('pending event writes have a bounded queue and disposal waits for the original write owner', () => journal(async value => {
    const entered = deferred(); const release = deferred(); const original = value.file.writeFile.bind(value.file);
    value.file.writeFile = async bytes => { entered.resolve(); await release.promise; return original(bytes); };
    try {
      value.append({ type: 'stdout', text: 'first' }); await entered.promise;
      for (let index = 0; index < 30; index++) value.append({ type: 'stdout', text: 'x'.repeat(200000) });
      assert.equal(value.failure.name, 'ResourceLimitError'); assert.ok(value.queuedBytes <= 4 * 1024 * 1024);
      let disposed = false; const disposal = value.dispose().then(() => { disposed = true; });
      await Promise.resolve(); assert.equal(disposed, false);
      release.resolve(); await disposal; assert.equal(value.queuedBytes, 0);
    } finally { release.resolve(); }
  }));

  await check('cancellation during final path capture cannot transfer a late archive', () => journal(async value => {
    const path = join(directory, 'cancelled-file'); await filesystem.writeFile(path, 'bytes');
    value.append(after('capture'), [{ name: 'file', contentType: 'text/plain', path }]);
    const entered = deferred(); const release = deferred(); const original = TraceResources.prototype.captureFile;
    TraceResources.prototype.captureFile = async function(...parameters) { entered.resolve(); await release.promise; return original.apply(this, parameters); };
    const controller = new AbortController();
    let work;
    try {
      work = value.takeArchive(1, controller.signal); const rejected = assert.rejects(work, /original cancellation/);
      await entered.promise; controller.abort(new Error('original cancellation'));
      release.resolve(); await rejected; assert.equal(value.transferred, false);
    } finally { release.resolve(); TraceResources.prototype.captureFile = original; await work?.catch(() => {}); }
  }));

  await check('sealed archive readers own final files after journal disposal until their own cleanup settles', async () => {
    const value = await RunnerTraceJournal.create(context(), { sources: false, attachments: true });
    value.append(after('body'), [body('kept', 'retained')]);
    const archive = await value.takeArchive(1, signal());
    const reader = archive.acquire();
    try {
      await value.dispose();
      const resource = reader.entries.find(entry => entry.name === `resources/${hash('retained')}`);
      assert.equal((await filesystem.readFile(resource.path)).toString(), 'retained');
      let disposed = false; const disposal = archive.dispose().then(() => { disposed = true; });
      await Promise.resolve(); assert.equal(disposed, false);
      reader.release(); await disposal;
      await assert.rejects(filesystem.access(value.directory), { code: 'ENOENT' });
      await assert.rejects(filesystem.access(resource.path), { code: 'ENOENT' });
      await assert.rejects(value.takeArchive(1, signal()), /already been sealed/);
    } finally { reader.release(); await archive.dispose(); await value.dispose(); }
  });

  await check('journal corruption rejects the whole archive and preserves a preexisting export destination', () => journal(async value => {
    value.append({ type: 'stdout', text: 'original' }); await value.writes;
    await filesystem.writeFile(join(value.directory, 'events.jsonl'), '{"type":"stdout","text":"modified"}\n');
    const destination = join(directory, 'existing.zip'); await filesystem.writeFile(destination, 'old archive');
    await assert.rejects(value.takeArchive(1, signal()).then(archive => archive.export(destination, signal())), /journal changed/);
    assert.equal(await filesystem.readFile(destination, 'utf8'), 'old archive'); assert.equal(value.transferred, false);
  }));

  await check('event and disk stream limits include completed writes rather than resetting when their queue drains', async () => {
    await journal(async value => {
      for (let index = 0; index < 99999; index++) {
        value.append({ type: 'stdout', text: '' });
        if (index % 500 === 0) await value.writes;
      }
      await value.writes; assert.equal(value.failure, undefined);
      value.append({ type: 'stdout', text: 'over event limit' });
      assert.equal(value.failure.name, 'ResourceLimitError'); assert.equal(value.events, 99999);
    });
    await journal(async value => {
      const event = { type: 'stdout', text: 'x'.repeat(250000) };
      let written = 0;
      while (!value.failure) { value.append(event); await value.writes; written++; }
      assert.ok(written > 250 && written < 300);
      assert.equal(value.failure.name, 'ResourceLimitError'); assert.ok(value.streamBytes <= 64 * 1024 * 1024);
    });
  });

  await check('archive cleanup attempts resource removal even when stream-directory removal fails', async () => {
    const value = await RunnerTraceJournal.create(context(), { sources: false, attachments: true });
    value.append(after('cleanup'), [body('resource', 'cleanup bytes')]);
    const archive = await value.takeArchive(1, signal());
    const resourceDirectory = value.resources.directory;
    const original = filesystem.rm;
    filesystem.rm = async (path, ...parameters) => {
      if (path === value.directory) throw Error('original directory cleanup failure');
      return original(path, ...parameters);
    };
    try {
      await assert.rejects(archive.dispose(), /original directory cleanup failure/);
      await assert.rejects(filesystem.access(resourceDirectory), { code: 'ENOENT' });
      await assert.rejects(value.dispose(), /original directory cleanup failure/);
    } finally { filesystem.rm = original; await original(value.directory, { recursive: true, force: true }); }
  });

  await check('all emitted archives have independently valid ZIP CRCs', async () => {
    execFileSync('python3', ['-c', 'import sys,zipfile\nfor path in sys.argv[1:]:\n with zipfile.ZipFile(path) as archive: assert archive.testzip() is None, path', ...exported]);
  });
  report.status = 'passed'; report.archiveCount = exported.length;
  console.log(JSON.stringify(report, null, 2));
} finally { await filesystem.rm(directory, { recursive: true, force: true }); }
