import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { verifyFinalGoalOwnerTree } from './final-goal-owner-tree.mjs';

const { fixtures } = JSON.parse(await readFile(new URL('../compatibility/evidence/fixtures/original-owner-tree.json', import.meta.url), 'utf8'));
const candidate = fixtures.find(fixture => fixture.engine === 'flashwright');
const reference = fixtures.find(fixture => fixture.engine === 'playwright');
const json = (evidence, field, change) => {
  const value = JSON.parse(evidence[field]); change(value); evidence[field] = JSON.stringify(value) + '\n';
};
const records = (file, change) => {
  const values = file.bytes.trimEnd().split('\n').map(JSON.parse); change(values);
  for (const [index, value] of values.entries()) if (Object.hasOwn(value, 'sequence')) value.sequence = index + 1;
  file.bytes = values.map(value => JSON.stringify(value)).join('\n') + '\n';
};
const journal = (evidence, role) => evidence.processJournals.find(file => JSON.parse(file.bytes.split('\n')[0]).role === role);
const nativeLedger = evidence => evidence.nativeCaptures.find(file => file.name.endsWith('.jsonl'));
// Keep transport counts coherent so native corruption controls reach the tree checks.
function refreshNativeCounts(evidence) {
  for (const file of evidence.nativeCaptures.filter(file => file.name.endsWith('.jsonl'))) {
    const completion = evidence.nativeCaptures.find(candidate => candidate.name === file.name.replace(/\.jsonl$/, '.complete.json'));
    if (!completion) continue;
    const value = JSON.parse(completion.bytes);
    value.retainedBytes = Buffer.byteLength(file.bytes);
    const count = file.bytes.trimEnd().split('\n').length;
    if (Object.hasOwn(value, 'records')) value.records = count;
    if (Object.hasOwn(value, 'datagramsReceived')) value.datagramsReceived = count;
    completion.bytes = JSON.stringify(value) + '\n';
  }
}

const guardian = (evidence, change) => {
  const value = JSON.parse(evidence.guardianReaps[0].bytes); change(value);
  evidence.guardianReaps[0].bytes = JSON.stringify(value) + '\n';
};

for (const fixture of fixtures) test(`${fixture.engine}: real raw capture reconstructs CPU once and concurrent RSS`, () => {
  const result = verifyFinalGoalOwnerTree(fixture.evidence);
  assert.equal(result.originalOwnerInclusiveCpuSeconds, fixture.expected.originalOwnerInclusiveCpuSeconds);
  assert.equal(result.sampledConcurrentBytes, fixture.expected.maximumSampledConcurrentRssBytes);
  assert.equal(result.ownedProcesses.length, fixture.expected.processes);
  assert.equal(result.maximumOverlappingAttempts, 1);
  assert.equal(result.finalResourceAdmission, false);
  assert(result.limitations.length > 0);
});

const controls = [
  ['missing original guardian reap', evidence => evidence.guardianReaps = []],
  ['duplicate guardian receipt', evidence => evidence.guardianReaps.push(structuredClone(evidence.guardianReaps[0]))],
  ['guardian receipt from another session', evidence => guardian(evidence, value => value.session = '0'.repeat(32))],
  ['guardian receipt for another driver', evidence => guardian(evidence, value => value.driverProcess++)],
  ['guardian receipt with failed terminal status', evidence => guardian(evidence, value => value.waitStatus = 256)],
  ['guardian receipt after original owner reap', evidence => guardian(evidence, value => value.waitCompletedNanoseconds = String(BigInt(JSON.parse(evidence.watchdogReportBytes).rootPollCpu.reapedNanoseconds) + 1n))],
  ['cached owner status', evidence => json(evidence, 'watchdogReportBytes', value => value.rootPollCpu.method = 'cached-status')],
  ['unavailable original owner CPU', evidence => json(evidence, 'watchdogReportBytes', value => value.rootPollCpu.status = 'unavailable')],
  ['inconsistent owner CPU total', evidence => json(evidence, 'watchdogReportBytes', value => value.rootPollCpu.cpuSeconds++)],
  ['nonterminal original owner wait status', evidence => json(evidence, 'watchdogReportBytes', value => value.rootPollCpu.waitStatus = 127)],
  ['changed enrolled plan', evidence => json(evidence, 'planBytes', value => value.session = '0'.repeat(32))],
  ['foreign enrolled worker parent', evidence => records(journal(evidence, 'worker'), values => values[0].nativeIdentity.parentUniqueId = '1')],
  ['missing original JS child exit', evidence => records(journal(evidence, 'runner'), values => values.splice(values.findIndex(value => value.kind === 'child-exit-observed'), 1))],
  ['coherently relabelled original runner exit', evidence => {
    records(journal(evidence, 'runner'), values => values.find(value => value.kind === 'process-exit-hook-observed').code = 1);
    records(journal(evidence, 'owner'), values => {
      for (const value of values.filter(value => ['child-exit-observed', 'child-close-observed'].includes(value.kind))) value.code = 1;
    });
  }],
  ['missing dispatched original callback', evidence => records(journal(evidence, 'worker'), values => values.splice(values.findIndex(value => value.kind === 'attempt-begin-dispatched'), 1))],
  ['mismatched callback identity', evidence => records(journal(evidence, 'worker'), values => values.find(value => value.kind === 'attempt-end-dispatched').callbackSha256 = '0'.repeat(64))],
  ['missing native launch', evidence => records(nativeLedger(evidence), values => values.splice(values.findIndex(value => value.event === 'native-child-launched'), 1))],
  ['missing native reap', evidence => records(nativeLedger(evidence), values => values.splice(values.findIndex(value => value.event === 'native-child-reaped'), 1))],
  ['native birth from different parent lifetime', evidence => records(nativeLedger(evidence), values => values.find(value => value.event === 'native-child-launched').parentStartTicks = '1')],
  ['failed native drain', evidence => records(nativeLedger(evidence), values => values.find(value => value.event === 'native-resource-drain').pendingObservations = 1)],
  ['unknown native record', evidence => records(nativeLedger(evidence), values => values.push({ event: 'ignored-foreign-process' }))],
  ['unterminated native record', evidence => { const file = nativeLedger(evidence); file.bytes = file.bytes.trimEnd(); }],
  ['different live kernel birth', evidence => records(journal(evidence, 'owner'), values => values.find(value => value.kind === 'native-owner-chain-observed').nativeIdentities.at(-1).startTicks = '1')],
  ['unowned process in RSS sample', evidence => json(evidence, 'watchdogReportBytes', value => value.samples.find(sample => sample.processes.length).processes[0].process = 2147483647)],
  ['conflicting sampled start identity', evidence => json(evidence, 'watchdogReportBytes', value => value.samples.find(sample => sample.processes.length).processes[0].started = 'different start')],
  ['sample acquisition after owner reap', evidence => json(evidence, 'watchdogReportBytes', value => { const sample = value.samples.find(sample => sample.processes.length); sample.acquisitionStartedElapsedSeconds = value.elapsedSeconds + 1; sample.acquisitionFinishedElapsedSeconds = value.elapsedSeconds + 2; })],
  ['RSS total changed', evidence => json(evidence, 'watchdogReportBytes', value => value.maximumSampledConcurrentRssBytes++)],
  ['unknown capture file', evidence => evidence.nativeCaptures.push({ name: 'extra.json', bytes: '{}\n' })],
  ['duplicate process journal', evidence => evidence.processJournals.push(structuredClone(evidence.processJournals[0]))],
  ['unsafe capture filename', evidence => evidence.nativeCaptures[0].name = '../outside.json'],
];
for (const [name, mutate] of controls) test(`reject ${name}`, () => {
  const changed = structuredClone(candidate.evidence); mutate(changed); refreshNativeCounts(changed);
  assert.throws(() => verifyFinalGoalOwnerTree(changed));
});

test('forged successful summary cannot override missing original native reaping', () => {
  const changed = structuredClone(candidate.evidence);
  changed.precomputed = { ...verifyFinalGoalOwnerTree(candidate.evidence), status: 'passed', completeTreeCoverage: true };
  records(nativeLedger(changed), values => values.splice(values.findIndex(value => value.event === 'native-child-reaped'), 1));
  refreshNativeCounts(changed);
  assert.throws(() => verifyFinalGoalOwnerTree(changed));
});

test('reference process cannot borrow a candidate guardian receipt', () => {
  const changed = structuredClone(reference.evidence);
  changed.guardianReaps = structuredClone(candidate.evidence.guardianReaps);
  assert.throws(() => verifyFinalGoalOwnerTree(changed));
});

test('oversized original report is rejected before JSON parsing', () => {
  const changed = structuredClone(candidate.evidence);
  changed.watchdogReportBytes = ' '.repeat(33 * 1024 * 1024);
  assert.throws(() => verifyFinalGoalOwnerTree(changed));
});

for (const role of ['owner', 'runner', 'worker', 'driver', 'guardian', 'browser', 'native-child']) {
  for (const zeroRss of [false, true]) test(`reject post-reap ${role} sample with ${zeroRss ? 'zero' : 'original'} RSS`, () => {
    const reconstruction = verifyFinalGoalOwnerTree(candidate.evidence);
    const changed = structuredClone(candidate.evidence);
    json(changed, 'watchdogReportBytes', value => {
      const node = reconstruction.ownedProcesses.find(node => node.role === role
        && value.samples.some(sample => sample.processes.some(process => process.process === node.process)));
      assert(node, `Fixture needs an original ${role} sample`);
      const original = value.samples.flatMap(sample => sample.processes).find(process => process.process === node.process);
      const process = { ...original, rssBytes: zeroRss ? 0 : original.rssBytes };
      const reapedElapsed = Number(BigInt(value.rootPollCpu.reapedNanoseconds) - BigInt(value.clock.originNanoseconds)) / 1e9;
      assert(reapedElapsed < value.elapsedSeconds);
      value.samples.push({ elapsedSeconds: value.elapsedSeconds,
        acquisitionStartedElapsedSeconds: (reapedElapsed + value.elapsedSeconds) / 2,
        acquisitionFinishedElapsedSeconds: value.elapsedSeconds,
        liveOwnedProcesses: 1, concurrentRssBytes: process.rssBytes, processes: [process] });
    });
    assert.throws(() => verifyFinalGoalOwnerTree(changed), /Sample escapes retained original process lifetime/);
  });
}

test('invalid UTF-8 raw evidence is rejected without replacement decoding', () => {
  const changed = structuredClone(candidate.evidence);
  changed.ownerReportBytes = Buffer.from([0xff]);
  assert.throws(() => verifyFinalGoalOwnerTree(changed));
});

test('original owner kernel birth cannot precede the watchdog capture', () => {
  const changed = structuredClone(candidate.evidence);
  records(journal(changed, 'owner'), values => values[0].nativeIdentity.startTicks = '1');
  assert.throws(() => verifyFinalGoalOwnerTree(changed), /birth precedes|origin|watchdog/i);
});

test('owner reap instant must remain inside the original wait4 observation', () => {
  const changed = structuredClone(candidate.evidence);
  json(changed, 'watchdogReportBytes', value => value.rootPollCpu.finishedElapsedSeconds = value.rootPollCpu.startedElapsedSeconds);
  assert.throws(() => verifyFinalGoalOwnerTree(changed), /actual wait4 observation interval/);
});
