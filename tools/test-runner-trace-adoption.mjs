import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { adoptRunnerTraceJournal } = require('../packages/flashwright-runner/dist/commonjs/runner-trace-journal.js');
const { TraceResources } = require('../packages/flashwright-core/dist/commonjs/trace-resources.js');
const report = { status: 'running', checks: [] };
const fixture = '_setupWorkerTraceJournal';
const context = () => ({ type: 'context-options', version: 8, origin: 'testRunner', browserName: '', options: {}, wallTime: 1234, monotonicTime: 12, sdkLanguage: 'javascript' });
const deferred = () => { let resolve; const promise = new Promise(complete => { resolve = complete; }); return { promise, resolve }; };
const hash = value => createHash('sha1').update(value).digest('hex');
function testInfo(enabled = true) {
  const created = context();
  const original = () => { throw Error('original unbounded appender must not run'); };
  return { timeout: 1000, _tracing: {
    _contextCreatedEvent: created,
    _traceEvents: [created, { type: 'before', method: 'hook', title: 'Before Hooks', callId: 'before', startTime: 13 }, { type: 'before', method: 'fixture', title: `Fixture "${fixture}"`, callId: 'fixture', startTime: 14 }],
    traceOptions: () => enabled ? { sources: false, attachments: true, live: false } : undefined,
    appendForError: original, appendStdioToTrace: original, appendBeforeActionForStep: original, appendAfterActionForStep: original, _appendTraceEvent: original,
  } };
}
async function check(name, callback) { await callback(); report.checks.push(name); }
async function contents(journal) {
  const archive = await journal.takeArchive(1000, new AbortController().signal);
  const reader = archive.acquire();
  try {
    const entries = Object.fromEntries(await Promise.all(reader.entries.map(async entry => [entry.name, await readFile(entry.path)])));
    return { entries, records: entries['test.trace'].toString().trimEnd().split('\n').map(line => JSON.parse(line)) };
  } finally { reader.release(); await archive.dispose(); }
}
{
  await check('all five original appenders are replaced synchronously before blocked initialization', async () => {
    const original = TraceResources.create; const entered = deferred(); const release = deferred();
    TraceResources.create = async () => { entered.resolve(); await release.promise; return original.call(TraceResources); };
    const information = testInfo(); let admission;
    try {
      admission = adoptRunnerTraceJournal(fixture, information);
      assert.equal(admission.failure, undefined); assert.equal(information._tracing._traceEvents.length, 0);
      const tracing = information._tracing;
      const attachment = { name: 'body', contentType: 'text/plain', body: Buffer.from('early snapshot') };
      tracing.appendBeforeActionForStep({ stepId: 'action', category: 'test.step', title: 'early action', params: { repeated: [1, 1, null, undefined], object: { value: 1 } }, stack: [] });
      tracing.appendStdioToTrace('stdout', Buffer.from('early output'));
      tracing.appendAfterActionForStep('action', undefined, [attachment], [{ type: 'skip', description: 'annotation' }]);
      attachment.body.fill(120);
      tracing.appendForError({ message: 'outer', cause: { message: 'inner' }, stack: 'Error: outer\n    at body (/test/example.ts:3:4)' });
      tracing._appendTraceEvent({ type: 'stderr', timestamp: 123, text: 'direct normalized record' });
      assert.equal(tracing._traceEvents.length, 0); assert.equal(admission.journal.queuedAttachments, 1);
      assert.equal(adoptRunnerTraceJournal('_anotherHookScope', information), admission);
      await entered.promise; release.resolve();
      const result = await contents(admission.journal);
      const before = result.records.find(record => record.callId === 'action' && record.type === 'before');
      assert.deepEqual(before.params, { repeated: '[1, , null, undefined]', object: 'Object' });
      assert.equal(result.entries[`resources/${hash('early snapshot')}`].toString(), 'early snapshot');
      assert.equal(result.records.find(record => record.type === 'error').message, 'outer\n[cause]: inner');
      assert.deepEqual(result.records.find(record => record.type === 'error').stack, [{ file: '/test/example.ts', line: 3, column: 4, function: 'body' }]);
    } finally { release.resolve(); TraceResources.create = original; await admission?.journal?.dispose(); }
  });

  await check('preview and error conversion stay bounded without invoking caller hooks', async () => {
    const information = testInfo(); const admission = adoptRunnerTraceJournal(fixture, information);
    let accessed = 0;
    const array = [1]; Object.defineProperty(array, '1', { get() { accessed++; throw Error('array getter'); }, enumerable: true });
    const proxy = new Proxy([], { get() { accessed++; throw Error('proxy getter'); } });
    const callable = () => {}; callable.toString = () => { accessed++; throw Error('function serialization'); };
    const parameters = { array, proxy, callable, huge: 'x'.repeat(1024 * 1024) };
    Object.defineProperty(parameters, 'getter', { enumerable: true, get() { accessed++; throw Error('parameter getter'); } });
    try {
      information._tracing.appendBeforeActionForStep({ stepId: 'safe', category: 'test.step', title: 'safe previews', params: parameters, stack: [] });
      const result = await contents(admission.journal);
      const preview = result.records.find(record => record.callId === 'safe').params;
      assert.equal(accessed, 0);
      assert.equal(preview.array, '[1, [Accessor]]'); assert.equal(preview.proxy, '[Proxy]'); assert.equal(preview.callable, '[Function]'); assert.equal(preview.getter, '[Accessor]');
      assert.ok(preview.huge.endsWith('[Truncated]') && preview.huge.length < 5000);
    } finally { await admission.journal.dispose(); }
    const oversized = testInfo(); const rejected = adoptRunnerTraceJournal(fixture, oversized);
    try {
      oversized._tracing.appendForError({ message: 'x'.repeat(32769) });
      assert.equal(rejected.journal.failure.name, 'ResourceLimitError');
      await assert.rejects(rejected.journal.takeArchive(1, new AbortController().signal), { name: 'ResourceLimitError' });
    } finally { await rejected.journal.dispose(); }
  });

  await check('unexpected prefixes fail admission without opening files or running metadata accessors', async () => {
    const original = TraceResources.create; let creates = 0; let accessed = 0;
    TraceResources.create = async () => { creates++; return original.call(TraceResources); };
    try {
      for (const change of [
        value => value._tracing._traceEvents.push({ type: 'before', title: 'user work' }),
        value => Object.defineProperty(value._tracing._traceEvents[1], 'title', { get() { accessed++; throw Error('prefix getter'); } }),
        value => { value._tracing._traceEvents[2].title = 'Fixture "unexpected"'; },
      ]) {
        const information = testInfo(); change(information);
        const admission = adoptRunnerTraceJournal(fixture, information);
        assert.equal(admission.failure.name, 'ProtocolError'); assert.equal(admission.journal, undefined);
        information._tracing.appendForError({}); information._tracing.appendStdioToTrace('stdout', 'ignored');
        information._tracing.appendBeforeActionForStep({}); information._tracing.appendAfterActionForStep('ignored'); information._tracing._appendTraceEvent({});
        assert.equal(information._tracing._traceEvents.length, 0);
      }
      assert.equal(creates, 0); assert.equal(accessed, 0);
    } finally { TraceResources.create = original; }
  });

  await check('disabled attempts have no journal owner while successors have independent identities', async () => {
    const original = TraceResources.create; let creates = 0;
    TraceResources.create = async () => { creates++; return original.call(TraceResources); };
    let first; let second;
    try {
      const disabled = testInfo(false);
      assert.equal(adoptRunnerTraceJournal(fixture, disabled), undefined);
      disabled._tracing.appendBeforeActionForStep({ params: new Proxy({}, { ownKeys() { throw Error('disabled preview'); } }) });
      assert.equal(disabled._tracing._traceEvents.length, 0); assert.equal(creates, 0);
      first = adoptRunnerTraceJournal(fixture, testInfo()); second = adoptRunnerTraceJournal(fixture, testInfo());
      assert.notEqual(first, second); assert.notEqual(first.journal, second.journal);
    } finally { TraceResources.create = original; await first?.journal?.dispose(); await second?.journal?.dispose(); }
  });
  await check('only an actual skipped test may first adopt the bounded afterAll cleanup prefix', async () => {
    for (const skipped of [false, true]) {
      const information = testInfo(); information.status = skipped ? 'skipped' : 'passed'; information.expectedStatus = skipped ? 'skipped' : 'passed';
      information._tracing._traceEvents[1].title = 'After Hooks';
      information._tracing._traceEvents.splice(2, 0, { type: 'before', method: 'hook', title: 'afterAll hook', callId: 'afterAll', startTime: 13.5 });
      const admission = adoptRunnerTraceJournal(fixture, information);
      if (!skipped) { assert.equal(admission.failure.name, 'ProtocolError'); assert.equal(admission.journal, undefined); }
      else {
        try {
          assert.equal(admission.failure, undefined);
          const result = await contents(admission.journal);
          assert.deepEqual(result.records.slice(1).map(record => record.title), ['After Hooks', 'afterAll hook', `Fixture "${fixture}"`]);
        } finally { await admission.journal.dispose(); }
      }
    }
  });
  report.status = 'passed'; console.log(JSON.stringify(report, null, 2));
}
