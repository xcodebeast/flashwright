import assert from 'node:assert/strict';
import { eventNanoseconds, hashBytes, identityKey, runnerSpecifications,
  validateKernelIdentity } from './final-goal-owner-records.mjs';

const allowedKinds = new Set(['process-start-observed', 'process-exit-hook-observed',
  'launch-before', 'launch-returned', 'launch-threw', 'child-exit-observed', 'child-close-observed',
  'worker-configured', 'attempt-begin-dispatched', 'attempt-end-dispatched',
  'native-owner-chain-observed', 'native-owner-monitor-stopped']);

/** Reconcile original JS parent observations, child enrollment and all 15 dispatch/result identities. */
export function verifyJavaScriptOwners({ owner, resources, runner, prepared, plan, processJournals, launchRecords, planSha256 }) {
  const processes = [];
  for (const { name, bytes, value: records } of processJournals) {
    assert(name.endsWith('.jsonl'));
    assert.equal(bytes.at(-1), 10);
    const header = records[0];
    assert.equal(header.kind, 'process-start-observed');
    assert.equal(name, `${header.process}-${header.identity}.jsonl`);
    assert.match(header.identity ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    validateKernelIdentity(header.nativeIdentity);
    assert.deepEqual(header.clock, owner.clock);
    assert(['owner', 'runner', 'worker'].includes(header.role));
    assert.equal(records.filter(record => record.kind === 'process-start-observed').length, 1);
    assert.equal(header.planSha256, planSha256);
    assert.equal(header.clock.captureIdentity, resources.clock.identity);
    assert.equal(header.clock.originNanoseconds, resources.clock.originNanoseconds);
    assert.equal(header.entry, plan.entries[header.role]);
    assert.equal(header.enrollment, header.role === 'owner' ? 'owner-module-entry' : 'runner-configuration-import');
    assert.equal(header.nativeIdentity.process, header.process);
    assert(BigInt(header.nativeIdentity.uniqueId) > 0n);
    assert(BigInt(header.nativeIdentity.startedNanoseconds) <= BigInt(header.nativeIdentity.finishedNanoseconds));
    assert(BigInt(header.nativeIdentity.finishedNanoseconds) <= eventNanoseconds(header));
    let previous = BigInt(resources.clock.originNanoseconds);
    for (const [index, record] of records.entries()) {
      assert(allowedKinds.has(record.kind), `Unknown observation kind: ${record.kind}`);
      assert.equal(record.sequence, index + 1);
      assert.equal(record.identity, header.identity);
      assert.equal(record.process, header.process);
      assert(eventNanoseconds(record) >= previous);
      previous = eventNanoseconds(record);
    }
    assert(previous <= BigInt(resources.rootPollCpu.reapedNanoseconds));
    const hooks = records.filter(record => record.kind === 'process-exit-hook-observed');
    assert.equal(hooks.length, 1);
    assert.equal(records.filter(record => record.kind === 'launch-threw').length, 0);
    processes.push({ header, records, exitHook: hooks[0] });
  }
  assert.equal(new Set(processes.map(item => identityKey(item.header.nativeIdentity))).size, processes.length);
  assert.equal(new Set(processes.map(item => item.header.process)).size, processes.length, 'PID reuse requires separate analysis');
  assert.equal(new Set(processes.map(item => item.header.identity)).size, processes.length, 'Journal capture identity was reused');
  const roots = processes.filter(item => item.header.role === 'owner');
  const runners = processes.filter(item => item.header.role === 'runner');
  const workers = processes.filter(item => item.header.role === 'worker');
  assert.equal(roots.length, 1);
  assert.equal(runners.length, 1);
  assert.equal(roots[0].header.process, owner.ownerProcess);
  assert.equal(resources.rootPollCpu.process, owner.ownerProcess);
  assert.equal(resources.rootPollCpu.method, 'atomic-wait4-original-owner');
  assert.equal(resources.rootPollCpu.exitCode, roots[0].exitHook.code);
  assert.equal(runners[0].header.process, owner.runnerProcess);
  assert.equal(runners[0].exitHook.code, owner.runnerExit.code, 'Original runner terminal status differs from owner report');
  assert.equal(workers.length, prepared.family === 'failure' ? 15 : prepared.workers);
  const launchEdges = [];
  for (const parent of processes) {
    const before = parent.records.filter(record => record.kind === 'launch-before');
    const returned = parent.records.filter(record => record.kind === 'launch-returned');
    assert.equal(before.length, returned.length);
    assert.equal(new Set(before.map(record => record.callIdentity)).size, before.length);
    for (const [index, launch] of before.entries()) {
      assert.equal(launch.callIdentity, `${parent.header.identity}/${index + 1}`, 'Invalid original launch identity');
    }
    for (const launch of returned) validateKernelIdentity(launch.childIdentity);
    assert.equal(parent.records.filter(record => record.kind === 'child-exit-observed').length, returned.length);
    assert.equal(parent.records.filter(record => record.kind === 'child-close-observed').length, returned.length);
    assert.equal(new Set(returned.map(record => record.callIdentity)).size, returned.length);
    for (const launch of returned) {
      const start = before.filter(record => record.callIdentity === launch.callIdentity);
      const exits = parent.records.filter(record => record.kind === 'child-exit-observed' && record.callIdentity === launch.callIdentity);
      const closes = parent.records.filter(record => record.kind === 'child-close-observed' && record.callIdentity === launch.callIdentity);
      assert.equal(start.length, 1); assert.equal(exits.length, 1); assert.equal(closes.length, 1);
      const [exit] = exits, [close] = closes;
      assert(['spawn', 'fork'].includes(launch.operation));
      assert.equal(start[0].operation, launch.operation);
      assert(eventNanoseconds(start[0]) <= eventNanoseconds(launch) && eventNanoseconds(launch) <= eventNanoseconds(exit) && eventNanoseconds(exit) <= eventNanoseconds(close));
      assert(eventNanoseconds(start[0]) <= BigInt(launch.childIdentity.startedNanoseconds)
        && BigInt(launch.childIdentity.finishedNanoseconds) <= eventNanoseconds(launch));
      assert.equal(exit.childProcess, launch.childProcess);
      assert.equal(close.childProcess, launch.childProcess);
      assert.equal(exit.signal, null); assert.equal(close.signal, null);
      assert.equal(exit.code, close.code);
      assert(launch.childIdentity);
      assert.equal(launch.childIdentity.process, launch.childProcess);
      assert.equal(launch.childIdentity.parentUniqueId, parent.header.nativeIdentity.uniqueId);
      assert.equal(launch.childIdentity.originalParentVersion, parent.header.nativeIdentity.version);
      const child = processes.find(item => identityKey(item.header.nativeIdentity) === identityKey(launch.childIdentity));
      if (parent.header.role === 'owner' || parent.header.role === 'runner') {
        assert(child, 'Original JavaScript child did not enroll itself');
        assert.equal(child.header.role, parent.header.role === 'owner' ? 'runner' : 'worker');
        assert(launch.arguments.includes(child.header.entry));
        assert.equal(child.header.nativeIdentity.parentUniqueId, parent.header.nativeIdentity.uniqueId);
        assert.equal(child.header.nativeIdentity.originalParentVersion, parent.header.nativeIdentity.version);
        assert.equal(child.exitHook.code, exit.code);
        assert(eventNanoseconds(start[0]) <= eventNanoseconds(child.header) && eventNanoseconds(child.exitHook) <= eventNanoseconds(exit));
      } else {
        assert.equal(parent.header.role, 'worker');
        assert(!child, 'Unexpected extra JavaScript child');
        assert.equal(exit.code, 0);
        const nativeLaunch = launchRecords.filter(record => prepared.engine === 'playwright'
          ? record.browserProcess === launch.childProcess && record.captureOwnerProcess === parent.header.process
          : record.driverProcess === launch.childProcess);
        assert.equal(nativeLaunch.length, 1);
        const workerConfiguration = parent.records.filter(record => record.kind === 'worker-configured');
        assert.equal(workerConfiguration.length, 1);
        assert.equal(nativeLaunch[0].workerIndex, workerConfiguration[0].workerIndex);
        assert.equal(nativeLaunch[0].parallelIndex, workerConfiguration[0].parallelIndex);
        assert.equal(launch.arguments[0], prepared.engine === 'playwright' ? plan.browserExecutable : plan.driverExecutable);
      }
      launchEdges.push({ parent: parent.header.process, child: launch.childProcess,
        identity: launch.childIdentity, start: eventNanoseconds(start[0]), exit: eventNanoseconds(exit), close: eventNanoseconds(close) });
    }
  }
  assert.equal(launchRecords.length, workers.length);
  assert.equal(new Set(launchEdges.map(edge => edge.child)).size, launchEdges.length);
  assert.equal(launchEdges.filter(edge => edge.parent === owner.ownerProcess).length, 1);
  assert.equal(launchEdges.filter(edge => edge.parent === owner.runnerProcess).length, workers.length);
  for (const item of processes) {
    const terminalTime = item.header.role === 'owner' ? BigInt(resources.rootPollCpu.reapedNanoseconds)
      : launchEdges.find(edge => edge.child === item.header.process)?.exit;
    assert(terminalTime, 'Every enrolled process must have its physical parent observation');
    assert(item.records.every(record => eventNanoseconds(record) <= terminalTime));
    if (item.header.role !== 'worker') {
      assert(!item.records.some(record => ['worker-configured', 'attempt-begin-dispatched', 'attempt-end-dispatched'].includes(record.kind)));
    }
  }
  const specifications = runnerSpecifications(runner.suites);
  const allResults = specifications.flatMap(specification => specification.tests.flatMap(test => test.results));
  assert.equal(allResults.length, 15, 'Unexpected original report attempt count');
  const intervals = [];
  const workerIndices = new Set();
  for (const worker of workers) {
    const creations = worker.records.filter(record => record.kind === 'worker-configured');
    assert.equal(creations.length, 1);
    const { workerIndex, parallelIndex } = creations[0];
    assert(Number.isInteger(workerIndex) && workerIndex >= 0);
    assert(Number.isInteger(parallelIndex) && parallelIndex >= 0 && parallelIndex < prepared.workers);
    assert(!workerIndices.has(workerIndex), 'Worker index enrolled twice');
    workerIndices.add(workerIndex);
    const results = specifications.flatMap(specification => specification.tests.flatMap(test => test.results
      .filter(result => result.workerIndex === workerIndex).map(result => ({ specification, test, result }))));
    assert(results.length > 0);
    const starts = worker.records.filter(record => record.kind === 'attempt-begin-dispatched');
    const finishes = worker.records.filter(record => record.kind === 'attempt-end-dispatched');
    assert.equal(starts.length, results.length); assert.equal(finishes.length, starts.length);
    assert.equal(new Set(starts.map(record => record.attemptIdentity)).size, starts.length);
    assert.equal(new Set(finishes.map(record => record.attemptIdentity)).size, finishes.length);
    const unmatchedResults = [...results];
    const parentEdge = launchEdges.find(edge => edge.child === worker.header.process);
    assert(parentEdge);
    assert.equal(launchEdges.filter(edge => edge.parent === worker.header.process).length, 1);
    for (const [index, start] of starts.entries()) {
      assert.equal(start.attemptIdentity, `${worker.header.identity}/${index + 1}`, 'Invalid original attempt identity');
      assert(typeof start.testId === 'string' && start.testId.length > 0 && start.testId.length <= 4096);
      assert(creations[0].sequence < start.sequence, 'Attempt precedes worker configuration enrollment');
      const finish = finishes.find(record => record.attemptIdentity === start.attemptIdentity);
      assert(finish); assert.equal(finish.testId, start.testId); assert.equal(finish.retry, start.retry);
      assert.equal(finish.callbackSha256, start.callbackSha256);
      assert.match(start.callbackSha256, /^[a-f0-9]{64}$/);
      assert.equal(start.retry, 0);
      const matches = unmatchedResults.map((item, index) => ({ item, index })).filter(({ item }) =>
        (item.test.testId === start.testId || item.specification.id === start.testId) && item.result.retry === start.retry);
      assert.equal(matches.length, 1, 'Each original attempt must consume exactly one runner result');
      const result = unmatchedResults.splice(matches[0].index, 1)[0];
      assert.equal(start.retry, result.result.retry);
      assert.equal(finish.status, result.result.status);
      assert.equal(parallelIndex, result.result.parallelIndex);
      const annotations = result.result.annotations.filter(annotation => annotation.type === 'runner-suite-observation');
      assert.equal(annotations.length, 1);
      const observation = JSON.parse(annotations[0].description);
      assert.equal(observation.workerProcess, worker.header.process);
      assert(eventNanoseconds(start) <= eventNanoseconds(finish) && eventNanoseconds(finish) <= parentEdge.exit);
      if (index > 0) assert(eventNanoseconds(finishes[index - 1]) <= eventNanoseconds(start), 'Worker ran original attempts concurrently');
      intervals.push({ process: worker.header.process, workerIndex, parallelIndex, testId: start.testId,
        attemptIdentity: start.attemptIdentity, retry: start.retry, status: finish.status, callbackSha256: start.callbackSha256,
        start: eventNanoseconds(start), finish: eventNanoseconds(finish) });
    }
    assert.equal(unmatchedResults.length, 0);
  }
  assert.equal(intervals.length, 15);
  assert.equal(new Set(intervals.map(interval => interval.testId)).size, intervals.length, 'Original dispatch test identity was reused');
  assert(allResults.every(result => workerIndices.has(result.workerIndex)), 'Report contains an unenrolled worker');
  const points = intervals.flatMap(interval => [{ time: interval.start, delta: 1 }, { time: interval.finish, delta: -1 }])
    .sort((left, right) => left.time < right.time ? -1 : left.time > right.time ? 1 : left.delta - right.delta);
  let active = 0, maximumActive = 0;
  for (const point of points) { active += point.delta; maximumActive = Math.max(maximumActive, active); }
  assert.equal(active, 0);
  assert.equal(maximumActive, prepared.workers, 'Requested workers must overlap in actual original attempt execution');
  return { processes, intervals, workers: workers.length, maximumOverlappingAttempts: maximumActive };
}

/** Reconstruct live kernel joins internally; paths are compared without querying this host. */
export function reconstructNativeOwnerBridges({ plan, processes, launchRecords }) {
  const owners = processes.filter(records => records[0].role === 'owner');
  assert.equal(owners.length, 1);
  const owner = owners[0];
  for (const records of processes.filter(records => records !== owner)) {
    assert(!records.some(event => event.kind.startsWith('native-owner-')));
  }
  const observations = owner.filter(event => event.kind === 'native-owner-chain-observed');
  const stops = owner.filter(event => event.kind === 'native-owner-monitor-stopped');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].launches, observations.length);
  assert(observations.every(event => eventNanoseconds(event) <= eventNanoseconds(stops[0])));
  const names = launchRecords.map(record => record.name);
  assert.equal(observations.length, names.length);
  assert.equal(new Set(observations.map(event => event.launchFile)).size, names.length);
  const bridges = [];
  for (const name of names) {
    const { bytes, value: launch } = launchRecords.find(record => record.name === name);
    const matches = observations.filter(event => event.launchFile === name);
    assert.equal(matches.length, 1);
    const observation = matches[0];
    assert.equal(observation.launchSha256, hashBytes(bytes));
    assert.equal(observation.browserProcess, launch.browserProcess);
    const identities = observation.nativeIdentities;
    const identifiers = plan.engine === 'playwright'
      ? [launch.captureOwnerProcess, launch.browserProcess]
      : [launch.driverProcess, launch.guardianProcess, launch.browserProcess];
    assert.deepEqual(identities.map(identity => identity.process), identifiers);
    assert.equal(new Set(identities.map(identityKey)).size, identities.length);
    for (const [index, identity] of identities.entries()) {
      validateKernelIdentity(identity);
      assert(BigInt(identity.startedNanoseconds) <= BigInt(identity.finishedNanoseconds));
      assert(BigInt(identity.finishedNanoseconds) <= eventNanoseconds(observation));
      if (index === 0) continue;
      assert(BigInt(identity.startedNanoseconds) >= BigInt(identities[index - 1].finishedNanoseconds));
      assert.equal(identity.parentUniqueId, identities[index - 1].uniqueId);
      assert.equal(identity.originalParentVersion, identities[index - 1].version);
    }
    const workers = processes.filter(records => records[0].role === 'worker');
    const worker = workers.find(records => {
      const configuration = records.find(event => event.kind === 'worker-configured');
      return configuration.workerIndex === launch.workerIndex && configuration.parallelIndex === launch.parallelIndex;
    });
    assert(worker);
    const launchedProcess = plan.engine === 'playwright' ? launch.browserProcess : launch.driverProcess;
    const spawn = worker.filter(event => event.kind === 'launch-returned' && event.childProcess === launchedProcess);
    assert.equal(spawn.length, 1);
    const firstIdentity = plan.engine === 'playwright' ? identities[1] : identities[0];
    const originalIdentity = spawn[0].childIdentity;
    assert.equal(firstIdentity.process, originalIdentity.process);
    assert.equal(firstIdentity.uniqueId, originalIdentity.uniqueId);
    assert.equal(firstIdentity.startTicks, originalIdentity.startTicks);
    assert.equal(firstIdentity.parentUniqueId, originalIdentity.parentUniqueId);
    assert.equal(firstIdentity.originalParentVersion, originalIdentity.originalParentVersion);
    const originalImage = originalIdentity.executablePath;
    const observedImage = firstIdentity.executablePath;
    const nativeBrowserImage = plan.nativeBrowserExecutable;
    const wrapperImage = plan.browserExecutable;
    let wrapperExecObserved = false;
    if (identityKey(firstIdentity) !== identityKey(originalIdentity)) {
      assert.equal(plan.engine, 'playwright');
      assert.equal(originalImage, wrapperImage);
      assert.equal(observedImage, nativeBrowserImage);
      // XNU allocates exec versions from the global nextpidversion counter.
      // Other forks and execs may intervene; reject wraparound conservatively.
      assert(Number.isInteger(firstIdentity.version) && firstIdentity.version <= 0xffffffff);
      assert(Number.isInteger(originalIdentity.version) && originalIdentity.version >= 0);
      assert(firstIdentity.version > originalIdentity.version);
      assert(BigInt(originalIdentity.finishedNanoseconds) <= BigInt(firstIdentity.startedNanoseconds));
      wrapperExecObserved = true;
    } else {
      assert.equal(originalImage, observedImage);
    }
    assert.equal(identities.at(-1).executablePath, nativeBrowserImage);
    if (plan.engine === 'flashwright') {
      assert.equal(observedImage, plan.driverExecutable);
      assert.equal(identities[1].executablePath, observedImage);
    }

    const workerIdentity = worker[0].nativeIdentity;
    if (plan.engine === 'playwright') {
      assert.equal(identityKey(identities[0]), identityKey(workerIdentity));
      assert.equal(identities[0].startTicks, workerIdentity.startTicks);
    }
    else {
      assert.equal(firstIdentity.parentUniqueId, workerIdentity.uniqueId);
      assert.equal(firstIdentity.originalParentVersion, workerIdentity.version);
    }
    const exited = worker.filter(event => event.kind === 'child-exit-observed' && event.childProcess === launchedProcess);
    assert.equal(exited.length, 1);
    const launching = worker.filter(event => event.kind === 'launch-before' && event.callIdentity === spawn[0].callIdentity);
    assert.equal(launching.length, 1);
    assert(eventNanoseconds(launching[0]) <= BigInt(identities[0].startedNanoseconds));
    assert(eventNanoseconds(observation) <= eventNanoseconds(exited[0]));
    bridges.push({ workerProcess: worker[0].process, browserProcess: launch.browserProcess,
      identities, wrapperExecObserved, launchSha256: observation.launchSha256, observedNanoseconds: observation.nanoseconds });
  }
  assert.equal(new Set(bridges.map(bridge => bridge.browserProcess)).size, bridges.length);
  return bridges;
}
