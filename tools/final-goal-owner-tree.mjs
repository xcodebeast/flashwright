import assert from 'node:assert/strict';
import { canonicalAbsolutePath, decimalNanoseconds, hashBytes, positiveProcessId, readOwnerTreeEvidence,
  runnerSpecifications } from './final-goal-owner-records.mjs';
import { reconstructNativeOwnerBridges, verifyJavaScriptOwners } from './final-goal-owner-javascript.mjs';
import { reconstructCompleteOwnerTree, verifySampledOwnerCensus } from './final-goal-owner-native.mjs';

const controlledFamilies = new Set(['interaction', 'assertion', 'navigation', 'setup', 'backend', 'failure']);
const ownerEventNames = ['fixture-start-requested', 'fixture-listening', 'runner-spawn-requested', 'runner-closed',
  'runner-streams-retained', 'reporter-output-readable', 'fixture-close-requested', 'fixture-closed', 'owner-report-write-requested'];

function floatingPointSpacing(value) {
  assert(Number.isFinite(value) && value >= 0);
  const storage = new DataView(new ArrayBuffer(8));
  storage.setFloat64(0, value);
  const exponent = Number((storage.getBigUint64(0) >> 52n) & 0x7ffn);
  return exponent === 0 ? Number.MIN_VALUE : 2 ** (exponent - 1023 - 52);
}

/** Bound float timer subtraction and seconds-to-nanoseconds rounding by their IEEE-754 spacing. */
function elapsedClockRoundingNanoseconds(origin, elapsedSeconds) {
  const latestAbsoluteSeconds = Number(origin + BigInt(Math.ceil(elapsedSeconds * 1e9))) / 1e9;
  // Each absolute timer has at most half an ULP of rounding. Use the next
  // binade's spacing as well because the reconstructed absolute upper bound
  // can round across a power of two. Subtraction and product each add half an ULP.
  const absoluteTimerError = 2 * floatingPointSpacing(latestAbsoluteSeconds);
  const subtractionError = floatingPointSpacing(elapsedSeconds) / 2;
  const productError = floatingPointSpacing(elapsedSeconds * 1e9) / 2;
  return BigInt(Math.ceil((absoluteTimerError + subtractionError) * 1e9 + productError));
}

function validateControlledInputs({ watchdog: resources, owner, runner, prepared, plan, launchRecords }) {
  assert(['flashwright', 'playwright'].includes(plan.engine), 'Unsupported controlled-family engine');
  assert(controlledFamilies.has(prepared.family), 'Unsupported controlled workload family');
  assert([1, 4].includes(prepared.workers), 'Unsupported controlled worker count');
  assert.equal(prepared.engine, plan.engine);
  assert.equal(owner.engine, prepared.engine);
  assert.equal(owner.family, prepared.family);
  assert.equal(owner.workers, prepared.workers);
  assert.match(plan.session ?? '', /^[a-f0-9]{32}$/);
  for (const path of [plan.guardianReapDirectory, plan.outputDirectory, plan.launchDirectory, plan.commonModule,
    plan.browserExecutable, plan.driverExecutable, plan.nativeBrowserExecutable, ...Object.values(plan.entries ?? {})]) {
    canonicalAbsolutePath(path);
  }
  assert.deepEqual(Object.keys(plan.entries).sort(), ['owner', 'runner', 'worker']);
  assert.equal(new Set(Object.values(plan.entries)).size, 3);
  const configuration = prepared.configuration;
  assert.equal(configuration.warmupIterations, 3);
  assert.equal(configuration.measuredIterations, 12);
  assert.deepEqual(configuration.workloads, [prepared.family]);
  const expectedTitles = [
    ...Array.from({ length: 3 }, (_, index) => `${prepared.family}/warmup/${index}`),
    ...Array.from({ length: 12 }, (_, index) => `${prepared.family}/sample/${index}`),
  ];
  assert.deepEqual(prepared.expectedTitles, expectedTitles);
  const specifications = runnerSpecifications(runner.suites);
  assert.deepEqual(specifications.map(specification => specification.title), expectedTitles);
  assert.equal(specifications.length, 15);
  assert.deepEqual(runner.errors, []);
  assert.equal(runner.config.workers, prepared.workers);
  assert.equal(runner.config.fullyParallel, prepared.workers === 4);
  assert.equal(runner.config.maxFailures, 0);
  assert.equal(runner.config.projects.length, 1);
  assert.equal(runner.config.projects[0].retries, 0);
  assert.equal(runner.config.projects[0].repeatEach, 1);
  assert.equal(runner.stats.expected, prepared.family === 'failure' ? 0 : 15);
  assert.equal(runner.stats.unexpected, prepared.family === 'failure' ? 15 : 0);
  assert.equal(runner.stats.flaky, 0);
  assert.equal(runner.stats.skipped, 0);
  for (const specification of specifications) {
    assert.equal(specification.tests.length, 1);
    const test = specification.tests[0];
    assert.equal(test.expectedStatus, 'passed');
    assert.equal(test.status, prepared.family === 'failure' ? 'unexpected' : 'expected');
    assert.equal(test.results.length, 1);
    assert.equal(test.results[0].status, prepared.family === 'failure' ? 'failed' : 'passed');
    assert.equal(test.results[0].retry, 0);
  }
  assert.equal(owner.schemaVersion, 1);
  positiveProcessId(owner.ownerProcess);
  positiveProcessId(owner.runnerProcess);
  assert.equal(owner.status, 'completed-owner');
  assert.deepEqual(owner.failures, []);
  assert.deepEqual(owner.runnerExit, { code: prepared.family === 'failure' ? 1 : 0, signal: null });
  assert.equal(resources.schemaVersion, 2);
  assert.equal(resources.exitCode, 0);
  assert.equal(resources.timedOut, false);
  assert.equal(resources.interrupted, false);
  assert.equal(resources.cleanup.wholeTreeEscalation, false);
  assert.deepEqual(resources.cleanupSignals, []);
  assert.deepEqual(resources.remainingObservedProcesses, []);
  assert(Number.isFinite(resources.elapsedSeconds) && resources.elapsedSeconds > 0 && resources.elapsedSeconds <= 86400);
  assert.equal(resources.clock.schemaVersion, 1);
  assert.equal(resources.clock.type, 'monotonic');
  assert.equal(resources.clock.implementation, 'mach_absolute_time()');
  assert.match(resources.clock.identity ?? '', /^[a-f0-9]{32}$/);
  const origin = decimalNanoseconds(resources.clock.originNanoseconds);
  assert.equal(owner.clock.schemaVersion, 1);
  assert.equal(owner.clock.captureIdentity, resources.clock.identity);
  assert.equal(owner.clock.originNanoseconds, resources.clock.originNanoseconds);
  assert.equal(owner.clock.domain, 'darwin-mach-absolute-time');
  assert.equal(owner.clock.implementation, 'mach_absolute_time()');
  for (const field of ['numerator', 'denominator']) {
    assert(Number.isSafeInteger(owner.clock[field]) && owner.clock[field] > 0 && owner.clock[field] <= 0xffffffff);
  }
  const receipt = resources.rootPollCpu;
  assert.equal(receipt.status, 'observed');
  assert.equal(receipt.method, 'atomic-wait4-original-owner');
  assert.equal(receipt.process, owner.ownerProcess);
  assert.equal(resources.ownerLaunch.process, owner.ownerProcess);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.waitStatus, 0);
  for (const field of ['userSeconds', 'systemSeconds', 'cpuSeconds']) {
    assert(Number.isFinite(receipt[field]) && receipt[field] >= 0, 'Invalid original owner inclusive CPU');
  }
  assert.equal(receipt.cpuSeconds, receipt.userSeconds + receipt.systemSeconds);
  assert(Number.isFinite(receipt.startedElapsedSeconds) && Number.isFinite(receipt.finishedElapsedSeconds)
    && 0 <= receipt.startedElapsedSeconds && receipt.startedElapsedSeconds <= receipt.finishedElapsedSeconds
    && receipt.finishedElapsedSeconds <= resources.elapsedSeconds);
  assert(Number.isFinite(resources.ownerLaunch.startedElapsedSeconds)
    && 0 <= resources.ownerLaunch.startedElapsedSeconds
    && resources.ownerLaunch.startedElapsedSeconds <= receipt.startedElapsedSeconds);
  const ownerReaped = decimalNanoseconds(receipt.reapedNanoseconds);
  assert(origin <= ownerReaped && ownerReaped <= origin + BigInt(Math.ceil(resources.elapsedSeconds * 1e9)));
  const rounding = elapsedClockRoundingNanoseconds(origin, resources.elapsedSeconds);
  assert(origin + BigInt(Math.floor(receipt.startedElapsedSeconds * 1e9)) - rounding <= ownerReaped
    && ownerReaped <= origin + BigInt(Math.ceil(receipt.finishedElapsedSeconds * 1e9)) + rounding,
  'Original owner reap instant escapes its actual wait4 observation interval');
  assert.deepEqual(owner.events.map(event => event.name), ownerEventNames);
  let previous = origin;
  for (const event of owner.events) {
    const timestamp = decimalNanoseconds(event.nanoseconds);
    assert(previous <= timestamp && timestamp <= ownerReaped);
    previous = timestamp;
  }
  assert(launchRecords.length > 0);
  assert.equal(new Set(launchRecords.map(record => record.value.browserProcess)).size, launchRecords.length);
  for (const { name, value: launch } of launchRecords) {
    positiveProcessId(launch.browserProcess);
    assert.equal(launch.executable, plan.browserExecutable);
    canonicalAbsolutePath(launch.profile);
    assert(Array.isArray(launch.arguments) && launch.arguments.length <= 256);
    assert(launch.arguments.every(argument => typeof argument === 'string'));
    assert(launch.arguments.reduce((bytes, argument) => bytes + Buffer.byteLength(argument), 0) <= 8192);
    if (plan.engine === 'flashwright') {
      assert.equal(launch.schemaVersion, 1);
      assert.equal(launch.session, plan.session);
      positiveProcessId(launch.driverProcess);
      positiveProcessId(launch.guardianProcess);
      assert.equal(name, `guardian-${launch.guardianProcess}.json`);
    } else {
      assert.equal(launch.kind, 'playwright');
      positiveProcessId(launch.captureOwnerProcess);
      assert.match(launch.captureId ?? '', /^worker-[1-9][0-9]*-[1-9][0-9]*$/);
      assert.equal(name, `${launch.captureId}.json`);
    }
  }
}

/**
 * Reconstruct one controlled-family owner tree from raw bytes, synchronously and without I/O.
 * Input files are bounded and hashed before parsing. No caller-provided bridge, graph or
 * completeness summary is accepted. Source, executable, workload and host admission is external.
 */
export function verifyFinalGoalOwnerTree(evidence) {
  const records = readOwnerTreeEvidence(evidence);
  validateControlledInputs(records);
  const { watchdog: resources, owner, runner, prepared, plan, processJournals, launchRecords } = records;
  const javascript = verifyJavaScriptOwners({ owner, resources, runner, prepared, plan, processJournals,
    launchRecords: launchRecords.map(record => record.value), planSha256: records.provenance.fixed.plan.sha256 });
  const processes = javascript.processes.map(process => process.records);
  const bridges = reconstructNativeOwnerBridges({ plan, processes, launchRecords });
  const tree = reconstructCompleteOwnerTree({ plan, resources, owner, processes, launchRecords,
    nativeCaptures: records.nativeCaptures, guardianReaps: records.guardianReaps, bridges });
  assert(tree.nodes.get(owner.ownerProcess).start >= decimalNanoseconds(resources.clock.originNanoseconds),
    'Original owner birth precedes watchdog capture origin');
  const census = verifySampledOwnerCensus(tree.nodes, resources);
  const ownedProcesses = [...tree.nodes.values()].sort((left, right) => left.process - right.process).map(node => ({
    ...node, startTicks: String(node.startTicks), start: String(node.start), end: String(node.end),
    ...(node.parentStartTicks === undefined ? {} : { parentStartTicks: String(node.parentStartTicks) }),
  }));
  return {
    originalOwnerInclusiveCpuSeconds: resources.rootPollCpu.cpuSeconds,
    sampledConcurrentBytes: census.sampledConcurrentBytes,
    ownedProcesses,
    workerIntervals: javascript.intervals.map(interval => ({ ...interval, start: String(interval.start), finish: String(interval.finish) })),
    maximumOverlappingAttempts: javascript.maximumOverlappingAttempts,
    counts: { processes: tree.nodes.size, javascriptProcesses: processes.length,
      workers: javascript.workers, attempts: javascript.intervals.length, browserLaunches: launchRecords.length,
      nativeChildren: tree.nativeChildren, nativeReaps: tree.nativeChildren, nativeDrains: tree.nativeDrains,
      guardianReaps: tree.guardianReaps, sampledProcesses: census.sampledProcesses },
    provenance: { schemaVersion: 1, engine: plan.engine, family: prepared.family, workers: prepared.workers,
      session: plan.session, ownerProcess: owner.ownerProcess, clockIdentity: resources.clock.identity,
      rawInputs: records.provenance, inventorySha256: hashBytes(JSON.stringify(records.provenance)),
      sampledBoundaryObservations: census.boundaryObservations, unsampledOwnedProcesses: census.unsampledOwnedProcesses },
    limitations: [
      'Supports only the six controlled-family schemas with 15 attempts at workers 1 or 4; external backend owners are not admitted.',
      'Raw hashes establish retained input integrity only; source, executable, host, same-boot and capture authenticity admission remains external.',
      'Canonical-looking executable paths are compared exactly without filesystem resolution; path strings do not prove executable identity.',
      'Dispatch hashes and results reconcile original observed attempts; callback source bodies and unchanged workload admission remain external.',
      'Ownership coverage depends on the separately admitted observer and native launch/reap instrumentation covering the declared process mechanisms.',
      'CPU is the original owner atomic wait4 inclusive record exactly once; descendant and sampled CPU are never added.',
      'RSS is a maximum of non-atomic process-table samples with coarse ps start tokens; short-lived memory and true peak memory are not established.',
      'Boundary-crossing observations remain included; current PID existence is neither queried nor used as historical reaping proof.',
      'This reconstruction does not grant final resource, performance or whole-matrix admission.',
    ],
    finalResourceAdmission: false,
  };
}
