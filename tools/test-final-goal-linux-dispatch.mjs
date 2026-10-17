import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyLinuxApplicationDispatch } from './final-goal-linux-dispatch.mjs';
import { syntheticDispatch } from './fixtures/linux-application-dispatch.mjs';

function fixture(workers = 1, engine = 'flashwright') {
  const bodies = Array.from({ length: 8 }, (_, i) => ({ title: `original ${i}`, line: i + 1, sha256: String(i).repeat(64) }));
  const prepared = { workers, engine, workspaceDirectory: '/synthetic', runnerCommand: ['/synthetic/bun', '/synthetic/node_modules/.bun/playwright@1.60.0/node_modules/playwright/cli.js'],
    generatedSources: [{ path: 'tests/example.spec.ts', testBodies: bodies }] };
  const reporter = { suites: [{ specs: bodies.map((body, i) => ({ id: `id-${i}`, file: 'example.spec.ts', line: body.line, title: body.title,
    tests: [{ results: [{ status: 'passed', retry: 0, workerIndex: 0, parallelIndex: 0, duration: 20, errors: [] }] }] })) }] };
  const owner = { clock: { originNanoseconds: '1', implementation: 'clock_gettime(CLOCK_MONOTONIC)' },
    events: [{ name: 'runner-spawn-requested', nanoseconds: '10' }, { name: 'runner-closed', nanoseconds: '100000' }] };
  const args = { prepared, preparedSha256: 'd'.repeat(64), owner, reporter,
    before: { inputs: { files: [], executables: { runtime: { resolvedPath: '/synthetic/bun' } } } },
    resources: { captureIdentity: 'a'.repeat(32) }, observerOriginalPath: '/synthetic/observer.cjs' };
  const raw = syntheticDispatch({ ...args, journalCount: workers });
  const verify = () => verifyLinuxApplicationDispatch({ ...args, bytes: Buffer.from(JSON.stringify(raw)) });
  return { args, raw, verify };
}
const event = (events, kind) => events.find(e => e.kind === kind);
function editJournal(f, change, index = 0, resequence = false) {
  const events = f.raw.journals[index].text.trimEnd().split('\n').map(line => JSON.parse(line));
  change(events, f);
  if (resequence) for (const [i, e] of events.entries()) { e.sequence = i + 1; e.nanoseconds = String(100 + i * 10); }
  f.raw.journals[index].text = events.map(e => JSON.stringify(e) + '\n').join('');
}

for (const workers of [1, 4]) test(`complete synthetic dispatch at ${workers} workers joins every original identity`, () => {
  const result = fixture(workers).verify();
  assert.equal(result.tests, 8); assert.equal(result.freshFixtureJsContexts, 8); assert.equal(result.workersObserved, workers);
  assert.equal(result.peakDispatchedAttemptOverlap, workers); assert.equal(result.dispatchJournalVerified, true);
  assert.equal(result.callbackDispatchVerified, false); assert.equal(result.nativeContextOwnershipVerified, false);
  assert.equal(result.nativeProcessCustodyVerified, false); assert.equal(result.resourceAdmission, false); assert.equal(result.performanceAccepted, false);
});

for (const [name, change] of [
  ['body hash', e => event(e, 'callback-entered').sourceBodySha256 = 'f'.repeat(64)],
  ['runtime text', e => event(e, 'callback-registered').runtimeFunctionText = 'changed'],
  ['unknown test', e => event(e, 'attempt-begin-dispatched').testId = 'missing'],
  ['worker', e => event(e, 'callback-entered').workerIndex = 2],
  ['slot', e => event(e, 'callback-returned').parallelIndex = 1],
  ['retry', e => event(e, 'callback-entered').retry = 1],
  ['context', e => event(e, 'callback-returned').contextIdentity = 'other'],
  ['return registration', e => event(e, 'callback-returned').registration = 2],
  ['return file', e => event(e, 'callback-returned').file = 'other'],
  ['return line', e => event(e, 'callback-returned').line++],
  ['return column', e => event(e, 'callback-returned').column++],
  ['return title', e => event(e, 'callback-returned').title = 'other'],
  ['return runtime hash', e => event(e, 'callback-returned').runtimeFunctionSha256 = 'f'.repeat(64)],
  ['return test id', e => event(e, 'callback-returned').testId = 'id-1'],
  ['rejected callback', e => event(e, 'callback-returned').outcome = 'rejected'],
  ['failed attempt', e => event(e, 'attempt-end-dispatched').status = 'failed'],
  ['duration', e => event(e, 'attempt-end-dispatched').duration++],
  ['negative duration', e => event(e, 'attempt-end-dispatched').duration = -1],
  ['clock identity', e => e[0].clock.identity = '0'.repeat(32)],
  ['clock origin', e => e[0].clock.originNanoseconds = '0'],
  ['clock implementation', e => e[0].clock.implementation = 'Date.now'],
  ['clock resolution', e => e[0].clock.resolutionSeconds = 0.001],
  ['observer', e => e[0].observerSha256 = '0'.repeat(64)],
  ['common module', e => e[0].commonSha256 = '0'.repeat(64)],
  ['prepared hash', e => e[0].preparedSha256 = '0'.repeat(64)],
  ['parent', e => e[0].parent = 1],
  ['executable', e => e[0].executable = '/bin/sh'],
  ['PID type', e => e[0].process = String(e[0].process)],
  ['negative worker', e => e[0].workerIndex = -1],
  ['fractional worker', e => e[0].workerIndex = 0.5],
  ['out-of-range slot', e => e[0].parallelIndex = 1],
  ['start ticks', e => e[0].processStartTicks = '01'],
  ['process identity', e => e[0].processIdentity += 'x'],
  ['unsuccessful exit', e => e.at(-1).code = 1],
  ['event sequence', e => e[2].sequence++],
  ['unknown event', e => e[2].kind = 'invented'],
  ['unknown field', e => e[2].ignored = true],
  ['timestamp before owner', e => e[1].nanoseconds = '1'],
  ['timestamp after owner', e => e.at(-1).nanoseconds = '100001'],
  ['noncanonical timestamp', e => e[1].nanoseconds = '01'],
  ['negative timestamp', e => e[1].nanoseconds = '-1'],
  ['numeric timestamp', e => e[1].nanoseconds = 100],
  ['reversed timestamps', e => e[2].nanoseconds = '11'],
  ['empty callback interval', e => event(e, 'callback-returned').nanoseconds = event(e, 'callback-entered').nanoseconds],
]) test(`rejects dispatch mutation: ${name}`, () => {
  const f = fixture(); editJournal(f, change); assert.throws(f.verify);
});

for (const kind of ['callback-returned', 'context-closed', 'worker-exit-hook', 'attempt-end-dispatched', 'callback-entered'])
  test(`rejects missing phase ${kind}`, () => {
    const f = fixture(); editJournal(f, events => events.splice(events.indexOf(event(events, kind)), 1), 0, true); assert.throws(f.verify);
  });
for (const kind of ['worker-enrolled', 'callback-entered', 'callback-returned', 'context-closed', 'attempt-end-dispatched', 'worker-exit-hook'])
  test(`rejects repeated phase ${kind}`, () => {
    const f = fixture(); editJournal(f, events => { const i = events.indexOf(event(events, kind)); events.splice(i, 0, structuredClone(events[i])); }, 0, true);
    assert.throws(f.verify);
  });
test('context first observation must follow its attempt begin', () => {
  const f = fixture(); editJournal(f, events => {
    const i = events.indexOf(event(events, 'context-first-observed')); [events[i - 1], events[i]] = [events[i], events[i - 1]];
  }, 0, true); assert.throws(f.verify, /Context first observation escapes/);
});
test('registration must precede its attempt begin', () => {
  const f = fixture(); editJournal(f, events => {
    const registration = events.splice(events.indexOf(event(events, 'callback-registered')), 1)[0];
    events.splice(events.indexOf(event(events, 'attempt-begin-dispatched')) + 1, 0, registration);
    // Keep registration numbering contiguous so the actual temporal invariant is tested.
    for (const e of events) if ('registration' in e) e.registration = e.registration === 1 ? 8 : e.registration - 1;
  }, 0, true); assert.throws(f.verify, /Callback registered after attempt began/);
});
test('duplicate captured source aliases cannot hide a changed common module', () => {
  const f = fixture(); f.args.before.inputs.files.push({ ...f.args.before.inputs.files[1], path: '/alias', sha256: 'f'.repeat(64) }); assert.throws(f.verify);
});
test('consistent captured resolved source alias remains inert and accepted', () => {
  const f = fixture(); f.args.before.inputs.files[1].path = '/missing/alias'; assert.equal(f.verify().tests, 8);
});
test('Playwright common source follows the captured package CLI without reopening root symlinks', () => {
  const f = fixture(4, 'playwright'); f.args.before.inputs.files[1].path = '/synthetic/node_modules/alias/lib/common/index.js';
  assert.equal(f.verify().tests, 8);
  f.args.prepared.runnerCommand[1] = '/substituted/cli.js'; assert.throws(f.verify, /Dispatch source absent/);
});
test('recorded observer must match the reference bytes, not only its own enrollment', () => {
  const f = fixture(); f.args.before.inputs.files[0].sha256 = 'f'.repeat(64);
  editJournal(f, e => e[0].observerSha256 = 'f'.repeat(64)); assert.throws(f.verify, /Unrecognized dispatch observer/);
});
test('worker clock must equal the original captured clock including resolution', () => {
  const f = fixture(); f.args.resources.workloadClock.resolutionSeconds = 1e-6;
  assert.throws(f.verify, /Worker clock differs from original captured clock/);
});
test('reporter duration and original worker are joined', () => {
  for (const field of ['duration', 'workerIndex', 'parallelIndex', 'retry']) {
    const f = fixture(); f.args.reporter.suites[0].specs[0].tests[0].results[0][field]++; assert.throws(f.verify);
  }
});
test('reporter must contain every dispatched attempt exactly once', () => {
  for (const change of [specs => specs.pop(), specs => specs.push(structuredClone(specs[0]))]) {
    const f = fixture(); change(f.args.reporter.suites[0].specs); assert.throws(f.verify);
  }
});
test('missing worker journals cannot remove original reported attempts', () => {
  const f = fixture(4); f.raw.journals.pop(); assert.throws(f.verify, /Dispatch inventory differs/);
});
test('duplicate journal and excessive journal count reject', () => {
  for (const count of [2, 33]) {
    const f = fixture(); f.raw.journals = Array(count).fill(f.raw.journals[0]); assert.throws(f.verify);
  }
});
test('journal byte/event limits and terminal newline are enforced', () => {
  for (const text of ['x'.repeat(1024 ** 2) + '\n', '{}\n'.repeat(4097), '{}', '\n']) {
    const f = fixture(); f.raw.journals[0].text = text; assert.throws(f.verify);
  }
});
test('strict parser rejects duplicate keys inside JSONL and the report container', () => {
  const f = fixture(); f.raw.journals[0].text = f.raw.journals[0].text.replace('"sequence":1', '"sequence":1,"sequence":1');
  assert.throws(f.verify, /Duplicate application JSON property/);
  assert.throws(() => verifyLinuxApplicationDispatch({ ...f.args, bytes: Buffer.from('{"schemaVersion":1,"schemaVersion":1,"journals":[]}') }), /Duplicate application JSON property/);
});
test('a context cannot be reused across attempts', () => {
  const f = fixture(); editJournal(f, events => {
    const contexts = events.filter(e => e.kind === 'context-first-observed');
    const old = contexts[1].contextIdentity, reused = contexts[0].contextIdentity;
    events.splice(events.indexOf(contexts[1]), 1);
    for (const e of events) if (e.contextIdentity === old) e.contextIdentity = reused;
  }, 0, true); assert.throws(f.verify);
});
test('overlapping attempts in the same parallel slot reject even across distinct workers', () => {
  const f = fixture(4);
  editJournal(f, events => { for (const e of events) if ('parallelIndex' in e) e.parallelIndex = 0; }, 1);
  for (const spec of f.args.reporter.suites[0].specs) if (spec.tests[0].results[0].workerIndex === 1) spec.tests[0].results[0].parallelIndex = 0;
  assert.throws(f.verify);
});
