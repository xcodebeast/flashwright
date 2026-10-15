import assert from 'node:assert/strict';
import { decimalNanoseconds, eventNanoseconds, positiveProcessId } from './final-goal-owner-records.mjs';

const nativeEventKinds = new Set(['native-child-launched', 'native-child-reaped', 'native-resource-drain']);
const nativeEdgeKey = event => `${event.pid}:${event.parentStartTicks}:${event.child}`;

/** Reconcile retained terminal waits and birth identities into one original-owner tree. */
export function reconstructCompleteOwnerTree({ plan, resources, owner, processes, launchRecords, nativeCaptures, guardianReaps, bridges }) {
  const nodes = new Map();
  const clock = owner.clock;
  const toNanoseconds = ticks => decimalNanoseconds(ticks) * BigInt(clock.numerator) / BigInt(clock.denominator);
  const edgeFor = processId => {
    const matches = processes.flatMap(records => records.filter(event => event.kind === 'child-exit-observed' && event.childProcess === processId));
    assert.equal(matches.length, 1, 'Every JS-owned child needs one original parent exit observation');
    assert.equal(matches[0].signal, null);
    return matches[0];
  };
  const addIdentity = (identity, parent, end, role) => {
    assert(!nodes.has(identity.process), 'PID reuse or duplicate ownership is not admitted');
    const startTicks = decimalNanoseconds(identity.startTicks);
    const start = toNanoseconds(identity.startTicks);
    assert(start <= decimalNanoseconds(identity.startedNanoseconds));
    assert(decimalNanoseconds(identity.startedNanoseconds) <= decimalNanoseconds(identity.finishedNanoseconds));
    assert(decimalNanoseconds(identity.finishedNanoseconds) <= end);
    nodes.set(identity.process, { ...identity, parent, startTicks, start, end, role });
  };
  for (const records of processes) {
    const header = records[0];
    const edge = header.role === 'owner' ? null : edgeFor(header.process);
    addIdentity(header.nativeIdentity, edge?.process ?? null,
      edge ? eventNanoseconds(edge) : decimalNanoseconds(resources.rootPollCpu.reapedNanoseconds), header.role);
    for (const launch of records.filter(event => event.kind === 'launch-returned')) {
      const child = processes.find(candidate => candidate[0].process === launch.childProcess);
      if (child) assert.equal(launch.childIdentity.startTicks, child[0].nativeIdentity.startTicks);
    }
  }
  const captures = new Map(nativeCaptures.map(record => [record.name, record]));
  const expectedCaptureNames = launchRecords.flatMap(({ value: launch }) => {
    const basename = plan.engine === 'flashwright' ? `guardian-${launch.guardianProcess}` : launch.captureId;
    return [`${basename}.complete.json`, `${basename}.jsonl`];
  });
  assert.equal(new Set(expectedCaptureNames).size, expectedCaptureNames.length, 'Native capture belongs to multiple launches');
  assert.deepEqual([...captures.keys()].sort(), expectedCaptureNames.sort(), 'Missing or extra native capture files');
  assert.equal(guardianReaps.length, plan.engine === 'flashwright' ? launchRecords.length : 0);
  const guardianReceipts = new Map();
  for (const { name, value: receipt } of guardianReaps) {
    positiveProcessId(receipt.guardianProcess);
    assert.equal(name, `guardian-${receipt.guardianProcess}.json`);
    assert(!guardianReceipts.has(receipt.guardianProcess), 'Duplicate guardian terminal wait receipt');
    guardianReceipts.set(receipt.guardianProcess, receipt);
  }
  let nativeChildren = 0;
  let nativeDrains = 0;
  for (const { value: launch } of launchRecords) {
    const matchingBridges = bridges.filter(item => item.browserProcess === launch.browserProcess);
    assert.equal(matchingBridges.length, 1);
    const observed = matchingBridges[0];
    const parentExit = edgeFor(plan.engine === 'flashwright' ? launch.driverProcess : launch.browserProcess);
    const exit = eventNanoseconds(parentExit);
    let browserEnd = exit;
    if (plan.engine === 'flashwright') {
      const receipt = guardianReceipts.get(launch.guardianProcess);
      assert(receipt, 'Missing original guardian terminal wait');
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.method, 'original-guardian-child-wait');
      assert.equal(receipt.session, plan.session);
      assert.equal(launch.session, plan.session);
      assert.equal(receipt.driverProcess, launch.driverProcess);
      assert.equal(receipt.code, 0);
      assert.equal(receipt.waitStatus, 0);
      assert.equal(receipt.signal, null);
      assert.equal(receipt.clock, 'mach_absolute_time');
      const waitStarted = decimalNanoseconds(receipt.waitStartedNanoseconds);
      const waitCompleted = decimalNanoseconds(receipt.waitCompletedNanoseconds);
      assert(waitStarted <= waitCompleted);
      assert(decimalNanoseconds(observed.observedNanoseconds) <= waitCompleted && waitCompleted <= exit);
      browserEnd = waitCompleted;
      addIdentity(observed.identities[0], observed.workerProcess, exit, 'driver');
      addIdentity(observed.identities[1], launch.driverProcess, browserEnd, 'guardian');
      assert(nodes.get(launch.guardianProcess).start <= waitStarted);
    } else {
      assert.equal(observed.identities[0].startTicks, String(nodes.get(observed.workerProcess).startTicks));
    }
    addIdentity(observed.identities.at(-1), plan.engine === 'flashwright' ? launch.guardianProcess : observed.workerProcess,
      browserEnd, 'browser');
    const basename = plan.engine === 'flashwright' ? `guardian-${launch.guardianProcess}` : launch.captureId;
    const completion = captures.get(`${basename}.complete.json`).value;
    const capture = captures.get(`${basename}.jsonl`);
    const events = capture.value;
    assert.equal(completion.status, 'captured');
    assert.equal(completion.error, null);
    assert.deepEqual(completion.browserExit, { process: launch.browserProcess, code: 0, signal: null });
    if (plan.engine === 'flashwright') {
      assert.equal(completion.guardianProcess, launch.guardianProcess);
      assert.equal(completion.shutdownDrainComplete, true);
      assert.equal(completion.datagramsReceived, events.length);
    } else {
      assert.equal(completion.captureOwnerProcess, observed.workerProcess);
      assert.equal(completion.records, events.length);
    }
    assert.equal(completion.retainedBytes, capture.bytes.length);
    assert(events.every(event => nativeEventKinds.has(event.event)), 'Unknown native diagnostic record');
    const births = events.filter(event => event.event === 'native-child-launched');
    const terminals = events.filter(event => event.event === 'native-child-reaped');
    const drains = events.filter(event => event.event === 'native-resource-drain');
    assert(births.length > 0 && births.length <= 8192);
    const birthKeys = births.map(nativeEdgeKey);
    const terminalKeys = terminals.map(nativeEdgeKey);
    assert.equal(new Set(birthKeys).size, births.length, 'Duplicate native birth');
    assert.equal(new Set(terminalKeys).size, terminals.length, 'Duplicate native terminal reap');
    assert.deepEqual([...birthKeys].sort(), [...terminalKeys].sort(), 'Native birth/reap inventory differs');
    assert.equal(drains.length, 1);
    assert.equal(drains[0].pid, launch.browserProcess);
    assert.equal(drains[0].outcome, 'complete');
    assert.equal(drains[0].pendingObservations, 0);
    assert.equal(drains[0].failedDiagnosticWrites, 0);
    nativeDrains++;
    const browserParentTicks = new Set(births.filter(birth => birth.pid === launch.browserProcess).map(birth => birth.parentStartTicks));
    assert.equal(browserParentTicks.size, 1, 'Native tree has no unique original browser root');
    const terminalsByKey = new Map(terminals.map(event => [nativeEdgeKey(event), event]));
    const birthsByChild = new Map(births.map(event => [event.child, event]));
    assert.equal(birthsByChild.size, births.length, 'Native PID reuse requires separate identity analysis');
    for (const birth of births) {
      positiveProcessId(birth.pid);
      positiveProcessId(birth.child);
      assert.equal(birth.timebaseNumerator, clock.numerator);
      assert.equal(birth.timebaseDenominator, clock.denominator);
      const terminal = terminalsByKey.get(nativeEdgeKey(birth));
      let ancestorBirth = birth;
      const visited = new Set();
      while (ancestorBirth.pid !== launch.browserProcess) {
        assert(!visited.has(ancestorBirth.child), 'Native ownership cycle');
        visited.add(ancestorBirth.child);
        const parentBirth = birthsByChild.get(ancestorBirth.pid);
        assert(parentBirth, 'Native child must trace to this original browser');
        assert.equal(parentBirth.childStartTicks, ancestorBirth.parentStartTicks);
        ancestorBirth = parentBirth;
      }
      assert.equal(terminal.waitStatus, 0, 'Abnormal native termination invalidates normal-suite accounting');
      for (const field of ['inclusiveUserMicroseconds', 'inclusiveSystemMicroseconds']) {
        assert(Number.isSafeInteger(terminal[field]) && terminal[field] >= 0, 'Invalid native inclusive CPU diagnostic');
      }
      assert(Number.isSafeInteger(terminal.inclusiveMaximumResidentBytes) && terminal.inclusiveMaximumResidentBytes > 0);
      assert(!nodes.has(birth.child), 'Native PID is reused or belongs to another owner');
      nodes.set(birth.child, { process: birth.child, parent: birth.pid,
        parentStartTicks: decimalNanoseconds(birth.parentStartTicks), startTicks: decimalNanoseconds(birth.childStartTicks),
        start: toNanoseconds(birth.childStartTicks), end: decimalNanoseconds(terminal.reapedNanoseconds), role: 'native-child' });
      nativeChildren++;
    }
  }
  assert.equal([...nodes.values()].filter(node => node.parent === null).length, 1);
  for (const node of nodes.values()) {
    assert(node.start <= node.end);
    if (node.parent === null) {
      assert.equal(node.process, owner.ownerProcess);
      continue;
    }
    const parent = nodes.get(node.parent);
    assert(parent, 'Missing original process owner');
    if (node.parentStartTicks !== undefined) assert.equal(node.parentStartTicks, parent.startTicks,
      'Native birth does not join original parent kernel start ticks');
    assert(parent.start <= node.start && node.end <= parent.end, 'Child lifetime or terminal reap escapes original parent');
    const visited = new Set([node.process]);
    let ancestor = parent;
    while (ancestor.parent !== null) {
      assert(!visited.has(ancestor.process), 'Ownership cycle');
      visited.add(ancestor.process);
      ancestor = nodes.get(ancestor.parent);
      assert(ancestor, 'Missing ownership ancestor');
    }
    assert.equal(ancestor.process, owner.ownerProcess);
  }
  return { nodes, nativeChildren, nativeDrains, guardianReaps: guardianReaps.length };
}

/** Bind every original watchdog snapshot to retained lifetimes without upgrading coarse ps identities. */
export function verifySampledOwnerCensus(nodes, resources) {
  const startTokens = new Map();
  const startToken = process => {
    positiveProcessId(process.process);
    assert(typeof process.started === 'string' && process.started.trim());
    assert(nodes.has(process.process), 'Unowned process in watchdog census');
    return process.started.trim().replace(/\s+/g, ' ');
  };
  assert(Array.isArray(resources.processes) && Array.isArray(resources.samples) && resources.samples.length > 0);
  assert(resources.samples.length <= 100000 && resources.processes.length <= 8192);
  for (const process of resources.processes) {
    const token = startToken(process);
    assert(!startTokens.has(process.process), 'Repeated watchdog PID in aggregate inventory');
    startTokens.set(process.process, token);
  }
  assert.equal(resources.observedProcessCount, startTokens.size);
  const origin = decimalNanoseconds(resources.clock.originNanoseconds);
  const seen = new Set();
  const boundaryObservations = [];
  let sampledConcurrentBytes = 0;
  let previousElapsed = 0;
  for (const [sampleIndex, sample] of resources.samples.entries()) {
    assert(Number.isFinite(sample.elapsedSeconds) && previousElapsed <= sample.elapsedSeconds && sample.elapsedSeconds <= resources.elapsedSeconds);
    previousElapsed = sample.elapsedSeconds;
    assert(Array.isArray(sample.processes) && sample.processes.length <= nodes.size);
    assert.equal(sample.liveOwnedProcesses, sample.processes.length);
    assert.equal(new Set(sample.processes.map(process => process.process)).size, sample.processes.length);
    let concurrentBytes = 0;
    let queryStart;
    let queryEnd;
    if (sample.processes.length) {
      const start = sample.acquisitionStartedElapsedSeconds;
      const end = sample.acquisitionFinishedElapsedSeconds;
      assert(Number.isFinite(start) && Number.isFinite(end) && 0 <= start && start <= end
        && end <= sample.elapsedSeconds && sample.elapsedSeconds <= resources.elapsedSeconds);
      queryStart = origin + BigInt(Math.floor(start * 1e9));
      queryEnd = origin + BigInt(Math.ceil(end * 1e9));
    }
    for (const process of sample.processes) {
      assert.equal(startToken(process), startTokens.get(process.process), 'Watchdog PID has conflicting start identities');
      const node = nodes.get(process.process);
      assert(node.start <= queryEnd && queryStart <= node.end, 'Sample escapes retained original process lifetime');
      assert(Number.isSafeInteger(process.rssBytes) && process.rssBytes >= 0);
      concurrentBytes += process.rssBytes;
      assert(Number.isSafeInteger(concurrentBytes));
      seen.add(process.process);
      if (!(node.start <= queryStart && queryEnd <= node.end)) {
        boundaryObservations.push({ sampleIndex, process: process.process, role: node.role, rssBytes: process.rssBytes });
      }
    }
    assert.equal(sample.concurrentRssBytes, concurrentBytes);
    sampledConcurrentBytes = Math.max(sampledConcurrentBytes, concurrentBytes);
  }
  assert.deepEqual([...seen].sort((left, right) => left - right), [...startTokens.keys()].sort((left, right) => left - right));
  assert.equal(resources.maximumSampledConcurrentRssBytes, sampledConcurrentBytes);
  return { sampledConcurrentBytes, sampledProcesses: seen.size, boundaryObservations,
    unsampledOwnedProcesses: [...nodes.keys()].filter(process => !seen.has(process)) };
}
