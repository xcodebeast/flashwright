import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { adaptFinalGoalResources, watchdogProcessIdentity } from './final-goal-resource-adapter.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const firstStart = 'Sun Oct 11 03:00:00 2026';
const secondStart = 'Sun Oct 11 03:00:01 2026';

function processObservation(process, started, rssBytes, cpuSeconds, state = 'S') {
  return { process, started, rssBytes, cpuSeconds, state, parent: 1, group: 11 };
}

function event(type, timestampMilliseconds, processId, startIdentity, extra = {}) {
  return { type, timestampMilliseconds, process: { processId, startIdentity }, ...extra };
}

/** Synthetic watchdog-schema snapshots and prospective events; never real collector admission. */
function fixture() {
  const watchdog = { schemaVersion: 2, cpuAccounting: 'maximum-per-observed-process-identity',
    command: ['synthetic-host-fixture'], exitCode: 0, timedOut: false, interrupted: false,
    elapsedSeconds: 0.1, samplingIntervalSeconds: 0.1, remainingObservedProcesses: [], cleanupSignals: [],
    coverage: 'Synthetic observations retain the real watchdog schema and sampling limits.',
    samples: [
      { elapsedSeconds: 0, processes: [processObservation(11, firstStart, 100, 0.1), processObservation(12, firstStart, 900, 0.2)] },
      { elapsedSeconds: 0.02, processes: [processObservation(11, firstStart, 1000, 0.2), processObservation(12, firstStart, 100, 0.4)] },
      { elapsedSeconds: 0.06, processes: [processObservation(11, firstStart, 200, 0.3), processObservation(12, firstStart, 100, 0.6)] },
      { elapsedSeconds: 0.1, processes: [processObservation(11, firstStart, 0, 0.4, 'Z'), processObservation(12, firstStart, 0, 0.8, 'Z')] },
    ] };
  const lifecycle = { schemaVersion: 1, provenance: { sourceSha256: hash('synthetic-lifecycle-source') },
    host: { namespace: 'synthetic-host', identitySha256: hash('synthetic-host') },
    clock: { type: 'monotonic', identity: 'synthetic-original-clock', watchdogOriginMilliseconds: 1000,
      ownerInterval: { startMilliseconds: 1010, endMilliseconds: 1090 } },
    events: [event('process-owned', 1000, 11, firstStart, { components: ['runner', 'workers'] }),
      event('process-owned', 1000, 12, firstStart, { components: ['browser'] }),
      event('worker-started', 1011, 11, firstStart, { workerIdentity: 'original-worker-1' }),
      event('worker-ended', 1088, 11, firstStart, { workerIdentity: 'original-worker-1' })] };
  return { watchdog, lifecycle, collectorSha256: hash('synthetic-adapter-source'), requiredResourceComponents: ['runner', 'workers', 'browser'] };
}

/** Recompute the original watchdog summaries after deliberate synthetic fixture changes. */
function reportBytes(watchdog) {
  const aggregate = new Map();
  for (const sample of watchdog.samples) {
    sample.liveOwnedProcesses = sample.processes.length;
    sample.concurrentRssBytes = sample.processes.reduce((sum, process) => sum + process.rssBytes, 0);
    for (const process of sample.processes) {
      const identity = `${process.process}/${process.started}`;
      aggregate.set(identity, { ...process, cpuSeconds: Math.max(process.cpuSeconds, aggregate.get(identity)?.cpuSeconds ?? 0) });
    }
  }
  watchdog.processes = [...aggregate.values()];
  watchdog.observedProcessCount = aggregate.size;
  watchdog.observedCpuSeconds = watchdog.processes.reduce((sum, process) => sum + process.cpuSeconds, 0);
  watchdog.maximumSampledConcurrentRssBytes = Math.max(...watchdog.samples.map(sample => sample.concurrentRssBytes));
  return Buffer.from(JSON.stringify(watchdog));
}

function input(state) {
  const watchdogReportBytes = reportBytes(state.watchdog);
  state.lifecycle.provenance.watchdogSha256 = hash(watchdogReportBytes);
  state.lifecycle.events.sort((left, right) => left.timestampMilliseconds - right.timestampMilliseconds);
  return { watchdogReportBytes, lifecycle: state.lifecycle, collectorSha256: state.collectorSha256,
    requiredResourceComponents: state.requiredResourceComponents };
}

test('simultaneous RSS and cumulative CPU come from original samples, not sums of process peaks', () => {
  const adapterInput = input(fixture());
  const original = structuredClone(adapterInput);
  const resources = adaptFinalGoalResources(adapterInput);
  assert.equal(resources.sampledConcurrentBytes, 1100);
  assert.equal(resources.observedProcessTreeCpuSeconds, 1.2000000000000002);
  assert.equal(resources.ownedProcesses.length, 2);
  assert.deepEqual(resources.captureInterval, { startMilliseconds: 1000, endMilliseconds: 1100 });
  assert.deepEqual(resources.workerIntervals, [{ identity: 'original-worker-1',
    hostProcessIdentity: 'synthetic-host/11/Sun Oct 11 03:00:00 2026', startMilliseconds: 1011, endMilliseconds: 1088 }]);
  assert.deepEqual(resources.missingRequiredProcessIdentities, []);
  assert.deepEqual(resources.coverage.missingRequiredComponents, []);
  assert.equal('status' in resources, false);
  assert.equal('accepted' in resources, false);
  assert.equal('admitted' in resources, false);
  assert.deepEqual(adapterInput.lifecycle, original.lifecycle);
  assert.deepEqual(adapterInput.watchdogReportBytes, Buffer.from(original.watchdogReportBytes));
});

test('distinct logical workers on one process share original host CPU and RSS exactly once', () => {
  const state = fixture();
  state.lifecycle.events.push(event('worker-started', 1012, 11, firstStart, { workerIdentity: 'original-worker-2' }),
    event('worker-ended', 1087, 11, firstStart, { workerIdentity: 'original-worker-2' }));
  const resources = adaptFinalGoalResources(input(state));
  assert.equal(resources.workerIntervals.length, 2);
  assert.equal(new Set(resources.workerIntervals.map(worker => worker.hostProcessIdentity)).size, 1);
  assert.equal(resources.ownedProcesses.length, 2);
  assert.equal(resources.sampledConcurrentBytes, 1100);
  assert.equal(resources.observedProcessTreeCpuSeconds, 1.2000000000000002);
});

test('PID reuse keeps CPU from both original starts without simultaneous double counting', () => {
  const state = fixture();
  for (const sample of state.watchdog.samples.slice(2)) sample.processes[0].started = secondStart;
  state.watchdog.samples[2].processes[0].cpuSeconds = 0.05;
  state.watchdog.samples[3].processes[0].cpuSeconds = 0.1;
  state.lifecycle.events = state.lifecycle.events.filter(entry => entry.type !== 'worker-ended');
  state.lifecycle.events.push(event('worker-ended', 1040, 11, firstStart, { workerIdentity: 'original-worker-1' }),
    event('process-ended', 1041, 11, firstStart), event('process-owned', 1042, 11, secondStart, { components: ['workers'] }),
    event('worker-started', 1043, 11, secondStart, { workerIdentity: 'original-worker-2' }),
    event('worker-ended', 1088, 11, secondStart, { workerIdentity: 'original-worker-2' }));
  const resources = adaptFinalGoalResources(input(state));
  assert.equal(resources.ownedProcesses.length, 3);
  assert.equal(resources.sampledConcurrentBytes, 1100);
  assert.equal(resources.observedProcessTreeCpuSeconds, 1.1);
  assert.notEqual(resources.workerIntervals[0].hostProcessIdentity, resources.workerIntervals[1].hostProcessIdentity);
});

test('known short-lived unsampled processes and explicit gaps remain original missing identities', () => {
  const state = fixture();
  state.lifecycle.events.push(event('process-owned', 1040, 13, secondStart, { components: ['database'] }),
    event('process-missing', 1045, 13, secondStart, { reason: 'Exited before the next original snapshot' }),
    event('process-ended', 1050, 13, secondStart),
    event('process-missing', 1065, 12, firstStart, { reason: 'A known child reparented before observation' }));
  state.requiredResourceComponents.push('database');
  const resources = adaptFinalGoalResources(input(state));
  assert.deepEqual(new Set(resources.missingRequiredProcessIdentities), new Set([
    'synthetic-host/13/Sun Oct 11 03:00:01 2026', 'synthetic-host/12/Sun Oct 11 03:00:00 2026']));
  assert.deepEqual(resources.coverage.missingRequiredComponents, ['database']);
  assert.equal(resources.coverage.missingProcessObservations[0].observations.length, 2);
  assert.equal(resources.sampledConcurrentBytes, 1100);
});

test('a zombie snapshot cannot revive the previous identity after explicit PID reuse', () => {
  const state = fixture();
  state.lifecycle.events.push(event('worker-ended', 1040, 11, firstStart, { workerIdentity: 'original-worker-1' }),
    event('process-ended', 1041, 11, firstStart), event('process-owned', 1042, 11, secondStart, { components: ['workers'] }));
  state.lifecycle.events = state.lifecycle.events.filter(entry => entry.timestampMilliseconds !== 1088);
  state.watchdog.samples[2].processes[0].state = 'Z';
  assert.throws(() => adaptFinalGoalResources(input(state)), /later original PID generation/);
});

test('a short logical worker between samples remains a gap even when its shared host was observed elsewhere', () => {
  const state = fixture();
  state.lifecycle.events.push(event('worker-started', 1040, 11, firstStart, { workerIdentity: 'short-worker' }),
    event('worker-ended', 1050, 11, firstStart, { workerIdentity: 'short-worker' }));
  const resources = adaptFinalGoalResources(input(state));
  assert.deepEqual(resources.missingRequiredProcessIdentities, ['synthetic-host/11/Sun Oct 11 03:00:00 2026']);
  assert.equal(resources.coverage.missingProcessObservations[0].observations[0].workerIdentity, 'short-worker');
});

test('zombie CPU resets retain the prior original maximum and the reset observation', () => {
  const state = fixture();
  state.watchdog.samples[3].processes[0].cpuSeconds = 0;
  const resources = adaptFinalGoalResources(input(state));
  assert.equal(resources.samples[3].processes[0].cpuSeconds, 0.3);
  assert.equal(resources.observedProcessTreeCpuSeconds, 1.1);
  assert.deepEqual(resources.coverage.cpuObservationResets, [{ identity: 'synthetic-host/11/Sun Oct 11 03:00:00 2026',
    timestampMilliseconds: 1100, previousCpuSeconds: 0.3, observedCpuSeconds: 0 }]);
});

test('missing component policy remains visible instead of a fabricated process observation', () => {
  const state = fixture(); state.requiredResourceComponents.push('mail');
  const resources = adaptFinalGoalResources(input(state));
  assert.deepEqual(resources.coverage.missingRequiredComponents, ['mail']);
  assert.equal(resources.ownedProcesses.length, 2);
});

test('failed termination and original remaining identity/signals are preserved', () => {
  const state = fixture(); state.watchdog.exitCode = -9; state.watchdog.timedOut = true;
  state.watchdog.remainingObservedProcesses = [12];
  state.watchdog.cleanupSignals = [{ process: 12, signal: 'SIGKILL', cleanupElapsedSeconds: 0.01 }];
  state.lifecycle.events.push(event('process-remaining', 1100, 12, firstStart));
  const resources = adaptFinalGoalResources(input(state));
  assert.equal(resources.ownerExitCode, -9); assert.equal(resources.timedOut, true);
  assert.deepEqual(resources.remainingOwnedProcesses, ['synthetic-host/12/Sun Oct 11 03:00:00 2026']);
  assert.deepEqual(resources.cleanupSignals, state.watchdog.cleanupSignals);
});

test('ps whitespace normalizes without replacing the opaque start identity', () => {
  assert.deepEqual(watchdogProcessIdentity('original-host', 11, ' Sun  Oct 11 03:00:00 2026  '),
    { identity: 'original-host/11/Sun Oct 11 03:00:00 2026', namespace: 'original-host', processId: 11, startIdentity: firstStart });
});

const invalidCases = [
  ['unsettled PID reuse', state => state.lifecycle.events.push(event('process-owned', 1040, 11, secondStart, { components: ['workers'] })), /Reused PID/],
  ['reused process identity', state => state.lifecycle.events.push(event('process-owned', 1040, 11, firstStart, { components: ['workers'] })), /registered more than once/],
  ['reused worker identity', state => state.lifecycle.events.push(event('worker-started', 1040, 11, firstStart, { workerIdentity: 'original-worker-1' })), /worker identity was reused/],
  ['conflicting worker host', state => state.lifecycle.events.at(-1).process.processId = 12, /Conflicting/],
  ['unsettled worker', state => state.lifecycle.events.pop(), /complete original lifetime/],
  ['worker before owner clock', state => state.lifecycle.events[2].timestampMilliseconds = 1005, /escapes complete owner/],
  ['worker ending after owner clock', state => state.lifecycle.events.at(-1).timestampMilliseconds = 1095, /escapes complete owner/],
  ['ended host with live worker', state => state.lifecycle.events.push(event('process-ended', 1040, 11, firstStart)), /unsettled logical worker/],
  ['unknown sampled process', state => state.lifecycle.events.splice(1, 1), /no explicit ownership/],
  ['late ownership registration', state => state.lifecycle.events[0].timestampMilliseconds = 1001, /precedes prospective ownership/],
  ['missing component provenance', state => delete state.lifecycle.events[0].components, /process components/],
  ['duplicate component provenance', state => state.lifecycle.events[0].components.push('workers'), /process components/],
  ['missing host provenance', state => delete state.lifecycle.host.identitySha256, /original host identity/],
  ['missing lifecycle source', state => delete state.lifecycle.provenance.sourceSha256, /lifecycle source provenance/],
  ['missing collector source', state => delete state.collectorSha256, /collector source provenance/],
  ['wall clock', state => state.lifecycle.clock.type = 'wall', /original monotonic clock/],
  ['missing monotonic origin', state => delete state.lifecycle.clock.watchdogOriginMilliseconds, /monotonic origin/],
  ['missing clock identity', state => delete state.lifecycle.clock.identity, /clock identity/],
  ['owner outside capture', state => state.lifecycle.clock.ownerInterval.endMilliseconds = 1101, /escapes watchdog/],
  ['sample outside capture', state => state.watchdog.samples[3].elapsedSeconds = 0.11, /outside capture bounds/],
  ['unbracketed owner start', state => state.watchdog.samples.shift(), /omit complete owner/],
  ['unbracketed owner end', state => state.watchdog.samples.pop(), /omit complete owner/],
  ['unproven remaining PID', state => state.watchdog.remainingObservedProcesses = [12], /Remaining PID lacks/],
  ['stale terminal remaining identity', state => state.lifecycle.events.push(event('process-remaining', 1040, 12, firstStart),
    event('process-ended', 1041, 12, firstStart)), /Terminal remaining process identity later ended/],
  ['unknown missing identity', state => state.lifecycle.events.push(event('process-missing', 1050, 99, firstStart, { reason: 'Unknown' })), /ownership provenance/],
  ['missing gap reason', state => state.lifecycle.events.push(event('process-missing', 1050, 12, firstStart)), /coverage reason/],
  ['unknown worker host', state => state.lifecycle.events[2].process.processId = 99, /original active worker host/],
  ['non-worker process host', state => state.lifecycle.events[2].process.processId = 12, /original active worker host/],
  ['unordered samples', state => [state.watchdog.samples[1], state.watchdog.samples[2]] = [state.watchdog.samples[2], state.watchdog.samples[1]], /unordered/],
  ['invented event', state => state.lifecycle.events.push(event('reporter-worker-index', 1050, 11, firstStart)), /Unknown lifecycle event/],
  ['duplicate sample identity', state => state.watchdog.samples[1].processes.push({ ...state.watchdog.samples[1].processes[0] }), /conflicting PID/],
  ['negative RSS', state => state.watchdog.samples[1].processes[0].rssBytes = -1, /sampled RSS/],
  ['negative CPU', state => state.watchdog.samples[1].processes[0].cpuSeconds = -1, /sampled CPU/],
];
for (const [description, mutate, expected] of invalidCases) test(`rejects ${description}`, () => {
  const state = fixture(); mutate(state); assert.throws(() => adaptFinalGoalResources(input(state)), expected);
});

test('retained bytes and lifecycle order cannot be replaced by supplied metadata', () => {
  const adapterInput = input(fixture());
  adapterInput.watchdogReportBytes = Buffer.concat([adapterInput.watchdogReportBytes, Buffer.from(' ')]);
  assert.throws(() => adaptFinalGoalResources(adapterInput), /bytes differ/);
  const unordered = input(fixture());
  [unordered.lifecycle.events[1], unordered.lifecycle.events[2]] = [unordered.lifecycle.events[2], unordered.lifecycle.events[1]];
  assert.throws(() => adaptFinalGoalResources(unordered), /unordered/);
});

test('forged watchdog aggregate summaries and missing sampled identities reject', () => {
  for (const mutate of [watchdog => { watchdog.observedCpuSeconds = 0.1; },
    watchdog => { watchdog.maximumSampledConcurrentRssBytes = 1; }, watchdog => { watchdog.observedProcessCount = 1; },
    watchdog => { watchdog.processes.pop(); }, watchdog => { watchdog.samples[1].concurrentRssBytes = 1; },
    watchdog => { watchdog.processes[0].cpuSeconds = 999; }]) {
    const adapterInput = input(fixture()); const watchdog = JSON.parse(adapterInput.watchdogReportBytes); mutate(watchdog);
    adapterInput.watchdogReportBytes = Buffer.from(JSON.stringify(watchdog));
    adapterInput.lifecycle.provenance.watchdogSha256 = hash(adapterInput.watchdogReportBytes);
    assert.throws(() => adaptFinalGoalResources(adapterInput), /differs|omits/);
  }
});

test('aggregate ordering preserves the contract CPU sum despite floating-point order differences', () => {
  const state = fixture();
  state.lifecycle.events.push(event('process-owned', 1000, 13, firstStart, { components: ['fixture-backend'] }));
  for (const sample of state.watchdog.samples) sample.processes.push(processObservation(13, firstStart, 1, 0.1));
  const adapterInput = input(state);
  const watchdog = JSON.parse(adapterInput.watchdogReportBytes);
  watchdog.processes.reverse();
  watchdog.observedCpuSeconds = watchdog.processes.reduce((total, process) => total + process.cpuSeconds, 0);
  adapterInput.watchdogReportBytes = Buffer.from(JSON.stringify(watchdog));
  adapterInput.lifecycle.provenance.watchdogSha256 = hash(adapterInput.watchdogReportBytes);
  const resources = adaptFinalGoalResources(adapterInput);
  const maxima = new Map();
  for (const sample of resources.samples) for (const process of sample.processes) maxima.set(process.identity, process.cpuSeconds);
  const contractCpuTotal = [...maxima.values()].reduce((total, value) => total + value, 0);
  assert.notEqual(watchdog.observedCpuSeconds, contractCpuTotal);
  assert.equal(resources.observedProcessTreeCpuSeconds, contractCpuTotal);
});
