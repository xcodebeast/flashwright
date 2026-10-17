import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { decodeLinuxApplicationJson } from './final-goal-linux-json.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const observerBytes = readFileSync(new URL('./linux-application-dispatch-observer.cjs', import.meta.url));
export const linuxDispatchObserver = Object.freeze({ bytes: observerBytes.length, sha256: hash(observerBytes) });
export const linuxDispatchLimits = Object.freeze({ maximumJournals: 32, maximumJournalBytes: 1024 ** 2, maximumEvents: 4096 });
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const timestamp = value => {
  assert(typeof value === 'string' && /^(0|[1-9][0-9]{0,29})$/.test(value), 'Invalid dispatch timestamp');
  return BigInt(value);
};
const keys = (value, expected) => assert.deepEqual(Object.keys(value ?? {}).sort(), [...expected].sort());
const registrationFields = ['registration', 'file', 'line', 'column', 'title', 'sourceBodySha256', 'runtimeFunctionSha256'];
const attemptFields = [...registrationFields, 'testId', 'retry', 'workerIndex', 'parallelIndex', 'contextIdentity'];
const eventFields = {
  'worker-enrolled': ['processIdentity', 'process', 'parent', 'processStartTicks', 'workerIndex', 'parallelIndex', 'clock',
    'preparedSha256', 'commonSha256', 'observerSha256', 'executable'],
  'callback-registered': [...registrationFields, 'runtimeFunctionText'],
  'attempt-begin-dispatched': ['testId'], 'context-first-observed': ['contextIdentity'],
  'callback-entered': attemptFields, 'callback-returned': [...attemptFields, 'outcome'],
  'context-closed': ['contextIdentity'], 'attempt-end-dispatched': ['testId', 'status', 'duration'], 'worker-exit-hook': ['code'],
};
const sourceKey = value => JSON.stringify([value.file, value.line, value.title]);

function peakOverlap(intervals) {
  const edges = intervals.flatMap(([start, end]) => {
    assert(timestamp(start) < timestamp(end), 'Empty or reversed dispatch interval');
    return [[BigInt(start), 1], [BigInt(end), -1]];
  }).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);
  let active = 0, peak = 0;
  for (const [, delta] of edges) { active += delta; assert(active >= 0); peak = Math.max(peak, active); }
  assert.equal(active, 0);
  return peak;
}

/** Records must come from the application loader's already-bound original bytes. */
export function verifyLinuxApplicationDispatch({ bytes, prepared, preparedSha256, owner, reporter, before, resources, observerOriginalPath }) {
  const raw = decodeLinuxApplicationJson(bytes);
  keys(raw, ['schemaVersion', 'journals']); assert.equal(raw.schemaVersion, 1);
  assert(Array.isArray(raw.journals) && raw.journals.length > 0 && raw.journals.length <= linuxDispatchLimits.maximumJournals);
  assert([1, 4].includes(prepared.workers));
  assert(['playwright', 'flashwright'].includes(prepared.engine));
  assert(integer(owner.runnerProcess, 1));
  const input = path => {
    const aliases = before.inputs.files.filter(r => r.path === path || r.resolvedPath === path);
    assert(aliases.length, 'Dispatch source absent from original capture');
    for (const receipt of aliases) {
      assert(integer(receipt.bytes, 1)); assert.match(receipt.sha256 ?? '', /^[a-f0-9]{64}$/);
      assert.equal(receipt.bytes, aliases[0].bytes); assert.equal(receipt.sha256, aliases[0].sha256);
    }
    return aliases[0];
  };
  const observer = input(observerOriginalPath);
  assert.equal(observer.sha256, linuxDispatchObserver.sha256, 'Unrecognized dispatch observer');
  assert.equal(observer.bytes, linuxDispatchObserver.bytes);
  // The prepared Playwright command already names its resolved package CLI.
  // Bun's inventory can retain only aliases beneath .bun, not the root symlink.
  if (prepared.engine === 'playwright') assert.equal(posix.basename(prepared.runnerCommand[1]), 'cli.js');
  const common = input(prepared.engine === 'playwright'
    ? posix.join(posix.dirname(prepared.runnerCommand[1]), 'lib/common/index.js')
    : posix.join(prepared.workspaceDirectory, 'packages/flashwright-runner/dist/upstream/lib/common/index.js'));
  const bodies = new Map();
  for (const source of prepared.generatedSources) for (const body of source.testBodies) {
    const key = sourceKey({ file: source.path, ...body });
    assert(!bodies.has(key), 'Ambiguous callback source'); bodies.set(key, body.sha256);
  }
  const reported = new Map();
  const visit = suite => {
    for (const spec of suite.specs ?? []) {
      assert(typeof spec.id === 'string' && spec.id && !reported.has(spec.id), 'Duplicate reported test id');
      reported.set(spec.id, spec);
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of reporter.suites) visit(suite);
  assert(reported.size > 0);
  const ownerEvents = new Map(owner.events.map(e => [e.name, timestamp(e.nanoseconds)]));
  const start = ownerEvents.get('runner-spawn-requested'), finish = ownerEvents.get('runner-closed');
  assert(typeof start === 'bigint' && typeof finish === 'bigint' && start < finish);
  const processes = new Set(), workers = new Set(), names = new Set(), contextIds = new Set(), testIds = new Set(), rows = [];
  for (const journal of raw.journals) {
    keys(journal, ['name', 'text']);
    assert(typeof journal.name === 'string' && !names.has(journal.name)); names.add(journal.name);
    assert(typeof journal.text === 'string' && journal.text.endsWith('\n')
      && Buffer.byteLength(journal.text) <= linuxDispatchLimits.maximumJournalBytes, 'Invalid dispatch journal size or termination');
    const lines = journal.text.slice(0, -1).split('\n');
    assert(lines.length > 0 && lines.length <= linuxDispatchLimits.maximumEvents, 'Dispatch event limit exceeded');
    const events = lines.map(line => decodeLinuxApplicationJson(Buffer.from(line)));
    const header = events[0]; assert.equal(header.kind, 'worker-enrolled');
    assert(integer(header.process, 1) && !processes.has(header.process) && header.process !== owner.runnerProcess); processes.add(header.process);
    assert(integer(header.workerIndex) && !workers.has(header.workerIndex)); workers.add(header.workerIndex);
    assert(integer(header.parallelIndex) && header.parallelIndex < prepared.workers);
    assert.equal(header.parent, owner.runnerProcess);
    assert.equal(journal.name, `${header.process}-${header.workerIndex}.jsonl`);
    assert(timestamp(header.processStartTicks) > 0n);
    assert.equal(header.processIdentity, `${resources.captureIdentity}/${header.process}/${header.processStartTicks}`);
    assert.deepEqual(header.clock, { schemaVersion: 1, type: 'monotonic', identity: resources.captureIdentity,
      originNanoseconds: owner.clock.originNanoseconds, implementation: owner.clock.implementation, resolutionSeconds: 1e-9 });
    assert.deepEqual(header.clock, resources.workloadClock, 'Worker clock differs from original captured clock');
    assert.equal(header.preparedSha256, preparedSha256);
    assert.equal(header.observerSha256, observer.sha256); assert.equal(header.commonSha256, common.sha256);
    assert.equal(header.executable, before.inputs.executables.runtime.resolvedPath);
    const registrations = new Map(), registrationKeys = new Set(), attempts = new Map(), contexts = new Map(), used = new Set();
    let previous = start;
    for (const [index, event] of events.entries()) {
      assert(Object.hasOwn(eventFields, event.kind), 'Unknown dispatch event');
      keys(event, ['sequence', 'kind', 'nanoseconds', ...eventFields[event.kind]]);
      assert.equal(event.sequence, index + 1);
      const now = timestamp(event.nanoseconds); assert(previous <= now && now <= finish, 'Dispatch event escapes owner interval'); previous = now;
      switch (event.kind) {
        case 'worker-enrolled': assert.equal(index, 0); break;
        case 'callback-registered': {
          const key = sourceKey(event);
          assert(bodies.has(key) && !registrationKeys.has(key), 'Unbound or duplicate callback registration'); registrationKeys.add(key);
          assert.equal(event.sourceBodySha256, bodies.get(key));
          assert(integer(event.line, 1) && integer(event.column));
          assert(typeof event.runtimeFunctionText === 'string' && event.runtimeFunctionText.length > 0);
          assert.equal(hash(event.runtimeFunctionText), event.runtimeFunctionSha256);
          assert.equal(event.registration, registrations.size + 1); registrations.set(event.registration, event); break;
        }
        case 'attempt-begin-dispatched':
          assert(reported.has(event.testId) && !attempts.has(event.testId)); attempts.set(event.testId, { begin: event }); break;
        case 'context-first-observed':
          assert.equal(event.contextIdentity, `${header.processIdentity}/context/${contexts.size + 1}`);
          assert(!contextIds.has(event.contextIdentity)); contextIds.add(event.contextIdentity);
          contexts.set(event.contextIdentity, { first: event }); break;
        case 'callback-entered':
        case 'callback-returned': {
          const attempt = attempts.get(event.testId), registration = registrations.get(event.registration), context = contexts.get(event.contextIdentity);
          assert(attempt && registration && context && !context.closed);
          for (const field of registrationFields) assert.equal(event[field], registration[field]);
          assert.equal(event.workerIndex, header.workerIndex); assert.equal(event.parallelIndex, header.parallelIndex); assert.equal(event.retry, 0);
          if (event.kind === 'callback-entered') {
            assert(!attempt.entered && !context.testId && !used.has(event.registration)); used.add(event.registration);
            attempt.entered = event; context.testId = event.testId;
          } else {
            assert(attempt.entered && !attempt.returned);
            for (const field of attemptFields) assert.equal(event[field], attempt.entered[field]);
            assert.equal(event.outcome, 'resolved'); attempt.returned = event;
          }
          break;
        }
        case 'context-closed': {
          const context = contexts.get(event.contextIdentity); assert(context && !context.closed && context.testId);
          const attempt = attempts.get(context.testId); assert(attempt.returned && !attempt.end); context.closed = event; break;
        }
        case 'attempt-end-dispatched': {
          const attempt = attempts.get(event.testId); assert(attempt && attempt.returned && !attempt.end);
          assert(contexts.get(attempt.entered.contextIdentity).closed); attempt.end = event; break;
        }
        case 'worker-exit-hook': assert.equal(index, events.length - 1); assert.equal(event.code, 0); break;
      }
    }
    assert.equal(events.at(-1).kind, 'worker-exit-hook');
    assert(attempts.size > 0 && contexts.size === attempts.size);
    for (const [testId, attempt] of attempts) {
      assert(!testIds.has(testId), 'Attempt appears in multiple workers'); testIds.add(testId);
      keys(attempt, ['begin', 'entered', 'returned', 'end']);
      const spec = reported.get(testId); assert.equal(spec.tests.length, 1); assert.equal(spec.tests[0].results.length, 1);
      const result = spec.tests[0].results[0], entered = attempt.entered, end = attempt.end;
      const registration = registrations.get(entered.registration), context = contexts.get(entered.contextIdentity);
      assert(registration.sequence < attempt.begin.sequence, 'Callback registered after attempt began');
      assert(attempt.begin.sequence < context.first.sequence && context.first.sequence < entered.sequence,
        'Context first observation escapes its attempt');
      assert.equal(sourceKey(entered), sourceKey({ file: 'tests/' + spec.file, line: spec.line, title: spec.title }));
      assert.equal(result.workerIndex, entered.workerIndex); assert.equal(result.parallelIndex, entered.parallelIndex);
      assert.equal(result.retry, 0); assert.equal(result.status, 'passed'); assert.equal(end.status, 'passed'); assert.deepEqual(result.errors, []);
      assert(Number.isFinite(end.duration) && end.duration >= 0); assert.equal(result.duration, end.duration);
      const times = ['begin', 'entered', 'returned', 'end'].map(k => attempt[k].nanoseconds);
      assert(timestamp(times[0]) <= timestamp(times[1]) && timestamp(times[1]) < timestamp(times[2]) && timestamp(times[2]) <= timestamp(times[3]));
      rows.push({ testId, sourceBodySha256: entered.sourceBodySha256, runtimeFunctionSha256: entered.runtimeFunctionSha256,
        workerIndex: entered.workerIndex, parallelIndex: entered.parallelIndex, contextIdentity: entered.contextIdentity,
        file: entered.file, line: entered.line, title: entered.title,
        callbackEnvelopeInterval: times.slice(1, 3), dispatchedAttemptInterval: [times[0], times[3]] });
    }
    assert.equal(peakOverlap(rows.filter(r => r.workerIndex === header.workerIndex).map(r => r.dispatchedAttemptInterval)), 1);
  }
  assert.deepEqual([...testIds].sort(), [...reported.keys()].sort(), 'Dispatch inventory differs from reported corpus');
  const callbackPeak = peakOverlap(rows.map(r => r.callbackEnvelopeInterval)), attemptPeak = peakOverlap(rows.map(r => r.dispatchedAttemptInterval));
  assert(callbackPeak <= attemptPeak && attemptPeak <= prepared.workers);
  for (let slot = 0; slot < prepared.workers; slot++) assert(peakOverlap(rows.filter(r => r.parallelIndex === slot).map(r => r.dispatchedAttemptInterval)) <= 1);
  return { status: 'verified-retained-dispatch-journal', tests: rows.length, workersObserved: workers.size,
    freshFixtureJsContexts: contextIds.size, peakCallbackEnvelopeOverlap: callbackPeak, peakDispatchedAttemptOverlap: attemptPeak,
    attempts: rows, dispatchJournalVerified: true, callbackDispatchVerified: false, nativeContextOwnershipVerified: false,
    nativeProcessCustodyVerified: false, resourceAdmission: false, performanceAccepted: false,
    scope: 'Passing nonretry journal consistency with the reference observer, captured common module, generated source bodies, reporter and owner. Runtime text hashes do not prove closure contents; envelopes include suspended work. Broader source admission and native ownership remain separate.' };
}
