import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { comparePaired, quantile } from './statistics.mjs';
import { finalGoalClockProjection } from '../tools/final-goal-clock-projection.mjs';
import { finalGoalAccountingClass, finalGoalAccountingClasses, finalGoalPlatformScope, finalGoalResourceRegressionRatios,
  verifyFinalGoalResourcePolicy } from './final-goal-resource-policy.mjs';

export const finalGoalScenarioIds = ['runner-interaction', 'runner-assertion', 'runner-navigation', 'runner-setup',
  'runner-backend', 'runner-failure', 'application-todomvc', 'application-svgomg', 'application-backend-corpus'];
const engines = ['playwright', 'flashwright'];
const cellIds = ['single-worker', 'matched-throughput'];
const nonwinningStatuses = ['unsupported', 'failed', 'noncomparable', 'unmeasured'];
const hashPattern = /^[a-f0-9]{64}$/;

export const finalGoalResourceVerifierPaths = Object.freeze([
  'benchmarks/final-goal-contract.mjs', 'benchmarks/final-goal-resource-policy.mjs', 'benchmarks/statistics.mjs',
  'tools/verify-final-goal.mjs', 'tools/final-goal-original-resources.mjs', 'tools/final-goal-owner-evidence.mjs',
  'tools/final-goal-owner-tree.mjs', 'tools/final-goal-owner-records.mjs', 'tools/final-goal-owner-javascript.mjs',
  'tools/final-goal-owner-native.mjs', 'tools/final-goal-clock-projection.mjs', 'tools/watchdog.py',
  'tools/final-goal-linux-evidence.mjs', 'tools/final_goal_linux_evidence.py',
  'tools/final-goal-linux-application.mjs', 'benchmarks/application-corpus.mjs', 'benchmarks/application-suite-contract.mjs',
  'tools/linux_cgroup_resources.py', 'tools/linux_cgroup_capture.py', 'tools/linux_cgroup_policy.py',
  'tools/final_goal_capture_context.py',
]);

/** Hash structured declarations independently of property insertion order. */
export function finalGoalHash(value) {
  function canonicalize(item) {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonicalize(item[key])]));
    return item;
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

/** Collector admission applies to one declared source, executable and host/boot context. */
export function finalGoalResourceContext(declaration) {
  return {
    configurationSha256: declaration.configurationSha256,
    sourceManifestSha256: finalGoalHash(declaration.sourceManifest),
    dependencyManifestSha256: finalGoalHash(declaration.dependencyManifest),
    hostIdentitySha256: declaration.host.identitySha256, bootIdentitySha256: declaration.host.bootIdentitySha256,
    resourceCollectorSha256: declaration.resourceCollectorSha256, lifecycleProducerSha256: declaration.lifecycleProducerSha256,
    runtimeSha256: declaration.runtimeSha256, browserSha256: declaration.browserSha256,
    driverSha256: declaration.driverSha256, launcherSha256: structuredClone(declaration.launcherSha256),
  };
}

function requireHash(value, description) {
  assert.match(value ?? '', hashPattern, description);
}

function requireManifest(manifest, description) {
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest) && Object.keys(manifest).length, description);
  for (const [path, digest] of Object.entries(manifest)) {
    assert.ok(path && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some(part => ['', '.', '..'].includes(part)), description);
    requireHash(digest, description);
  }
}

function requirePositive(value, description) {
  assert.ok(Number.isFinite(value) && value > 0, description);
}

function requireEvidence(evidence, description) {
  assert.ok(Array.isArray(evidence) && evidence.length, description);
  const paths = new Set();
  for (const entry of evidence) {
    assert.ok(typeof entry.path === 'string' && entry.path && !paths.has(entry.path), description);
    paths.add(entry.path);
    requireHash(entry.sha256, description);
  }
}

/** Keep approved final-goal policy separate from historical feature-admission thresholds. */
export function verifyFinalGoalConfiguration(configuration) {
  assert.equal(configuration.schemaVersion, 1);
  assert.equal(configuration.comparisonClass, 'complete-native-runner-final-goal');
  assert.ok(['draft', 'sealed'].includes(configuration.status));
  assert.deepEqual(configuration.scenarios.map(scenario => scenario.id), finalGoalScenarioIds);
  assert.equal(new Set(configuration.scenarios.map(scenario => scenario.countingGroup)).size, 9);
  assert.equal(configuration.scenarios.filter(scenario => scenario.kind === 'application').length, 3);
  assert.deepEqual(configuration.scenarios.map(scenario => scenario.kind), [...Array(6).fill('controlled'), ...Array(3).fill('application')]);
  assert.equal(configuration.minimumSpeedup, 2);
  assert.equal(configuration.minimumApplicationWins, 2);
  assert.equal(configuration.independentPairs, 8);
  assert.equal(configuration.statistics.bootstrapReplicates, 10000);
  assert.equal(configuration.statistics.confidenceLevel, 0.95);
  assert.ok(Number.isSafeInteger(configuration.statistics.seed));
  assert.deepEqual(configuration.cells.map(cell => ({ id: cell.id, workers: cell.workers })),
    [{ id: cellIds[0], workers: 1 }, { id: cellIds[1], workers: 4 }]);
  verifyFinalGoalResourcePolicy(configuration);
  assert.deepEqual(configuration.runtime, { name: 'bun', version: '1.4.2' });
  assert.equal(configuration.referenceVersion, '1.60.0');
  assert.equal(configuration.browserVersion, '148.0.7778.96');
  for (const scenario of configuration.scenarios) {
    assert.ok(typeof scenario.countingGroup === 'string' && scenario.countingGroup);
    assert.ok(Number.isSafeInteger(scenario.expectedTestCount) && scenario.expectedTestCount > 0);
    assert.ok(Array.isArray(scenario.requiredResourceComponents) && scenario.requiredResourceComponents.length);
    assert.equal(new Set(scenario.requiredResourceComponents).size, scenario.requiredResourceComponents.length);
    assert.ok(scenario.artifacts && scenario.scheduling);
    if (scenario.kind === 'controlled') assert.deepEqual(scenario.artifacts, { trace: 'off', video: 'off', screenshot: 'off', defaultFailureDocuments: true });
    if (configuration.status === 'sealed') {
      requireHash(scenario.applicationPolicySha256, `${scenario.id}: missing application policy identity`);
      requireManifest(scenario.sourceManifest, `${scenario.id}: missing source manifest`);
      assert.equal(scenario.expectedTests?.length, scenario.expectedTestCount, `${scenario.id}: incomplete test inventory`);
      assert.equal(new Set(scenario.expectedTests.map(test => test.id)).size, scenario.expectedTestCount);
      for (const test of scenario.expectedTests) {
        requireHash(test.bodySha256, `${scenario.id}: missing original callback identity`);
        assert.ok(['passed', 'intentional-failure'].includes(test.outcome));
        assert.ok(test.observations && typeof test.observations === 'object');
        if (test.outcome === 'intentional-failure') assert.ok(test.diagnosticIdentity && Object.keys(test.diagnosticIdentity).length);
      }
      for (const cellId of cellIds) assert.equal(typeof scenario.previouslySupported[cellId], 'boolean');
    }
  }
}

function verifyDeclaration(configuration, declaration) {
  assert.ok(declaration && ['draft', 'sealed'].includes(declaration.status));
  assert.equal(declaration.configurationSha256, finalGoalHash(configuration), 'Final configuration changed after declaration');
  if (declaration.status !== 'sealed' || configuration.status !== 'sealed') return false;
  // Linux diagnostics cannot flow through the existing owner-wait/RSS adapter.
  // Remove this guard only with original Linux reconstruction and admission.
  assert.notEqual(finalGoalAccountingClass(configuration), finalGoalAccountingClasses.linux,
    'Linux original-resource reconstruction and campaign admission are not integrated; sealing is unavailable');
  requireManifest(declaration.sourceManifest, 'Missing campaign source manifest');
  for (const path of finalGoalResourceVerifierPaths)
    requireHash(declaration.sourceManifest[path], `Missing resource verifier source: ${path}`);
  requireManifest(declaration.dependencyManifest, 'Missing pinned dependency manifest');
  requireHash(declaration.runtimeSha256, 'Missing runtime executable identity');
  requireHash(declaration.browserSha256, 'Missing browser executable identity');
  requireHash(declaration.driverSha256, 'Missing driver executable identity');
  requireHash(declaration.resourceCollectorSha256, 'Missing resource collector identity');
  assert.equal(declaration.sourceManifest[declaration.resourceCollectorPath], declaration.resourceCollectorSha256, 'Collector algorithm is absent from admitted campaign source');
  requireHash(declaration.lifecycleProducerSha256, 'Missing lifecycle producer identity');
  assert.equal(declaration.sourceManifest[declaration.lifecycleProducerPath], declaration.lifecycleProducerSha256,
    'Lifecycle producer is absent from admitted campaign source');
  requireEvidence(declaration.approvalEvidence, 'Missing premeasurement approval/ordering evidence');
  assert.ok(declaration.gates?.length, 'Missing behavior, lifecycle and source admission gates');
  assert.equal(new Set(declaration.gates.map(gate => gate.id)).size, declaration.gates.length);
  assert.deepEqual(declaration.gates.map(gate => gate.id).sort(), [...configuration.requiredGateIds].sort(), 'Required admission gates differ');
  for (const gate of declaration.gates) {
    assert.equal(gate.status, 'passed', `Admission gate did not pass: ${gate.id}`);
    requireHash(gate.verifierSha256, `Missing gate verifier identity: ${gate.id}`);
    assert.equal(declaration.sourceManifest[gate.verifierPath], gate.verifierSha256, `Gate verifier is absent from admitted source: ${gate.id}`);
    requireEvidence(gate.evidence, `Missing retained gate evidence: ${gate.id}`);
  }
  assert.equal(declaration.host.logicalCpuCount, configuration.resourcePolicy.logicalCpuCount);
  assert.equal(declaration.host.physicalMemoryBytes, configuration.resourcePolicy.physicalMemoryBytes);
  requireHash(declaration.host.identitySha256, 'Missing declared host identity');
  requireHash(declaration.host.bootIdentitySha256, 'Missing declared boot identity');
  for (const engine of engines) requireHash(declaration.launcherSha256?.[engine], 'Missing admitted browser launcher identity');
  return true;
}

/** Count overlapping owned worker intervals; four configured slots alone do not prove concurrency. */
function maximumIntervalConcurrency(intervals, ownerInterval) {
  assert.ok(Array.isArray(intervals) && intervals.length, 'Missing observed worker lifetimes');
  const events = [];
  const identities = new Set();
  for (const interval of intervals) {
    assert.ok(typeof interval.identity === 'string' && interval.identity && !identities.has(interval.identity), 'Duplicate worker lifetime');
    identities.add(interval.identity);
    assert.ok(Number.isFinite(interval.startMilliseconds) && Number.isFinite(interval.endMilliseconds)
      && interval.endMilliseconds > interval.startMilliseconds && interval.startMilliseconds >= ownerInterval.startMilliseconds
      && interval.endMilliseconds <= ownerInterval.endMilliseconds, 'Worker interval escapes complete owner clock');
    events.push([interval.startMilliseconds, 1], [interval.endMilliseconds, -1]);
  }
  events.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let current = 0, maximum = 0;
  for (const [, change] of events) { current += change; maximum = Math.max(maximum, current); }
  return maximum;
}

function verifyTests(report, resources, scenario, cell) {
  assert.equal(report.tests.length, scenario.expectedTests.length, 'Incomplete original suite');
  const actual = new Map(report.tests.map(test => [test.id, test]));
  assert.equal(actual.size, report.tests.length, 'Duplicate test observation');
  const contexts = new Set();
  const testIntervals = [];
  const usedWorkers = new Set();
  const failures = [];
  const workers = new Map(resources.workerIntervals.map(worker => [worker.identity, worker]));
  for (const expected of scenario.expectedTests) {
    const test = actual.get(expected.id);
    assert.ok(test, `Missing original test: ${expected.id}`);
    assert.equal(test.bodySha256, expected.bodySha256, 'Original callback body changed');
    assert.ok(['passed', 'failed', 'timedOut', 'skipped', 'interrupted'].includes(test.status), 'Invalid original test status');
    const expectedStatus = expected.outcome === 'intentional-failure' ? 'failed' : 'passed';
    if (test.status !== expectedStatus) {
      assert.ok(Array.isArray(test.errors) && (test.errors.length || ['skipped', 'interrupted'].includes(test.status)
        && typeof test.skipReason === 'string' && test.skipReason), 'Original failed/skipped attempt diagnostic is missing');
      failures.push({ testId: test.id, expectedStatus, observedStatus: test.status, originalErrors: test.errors, skipReason: test.skipReason });
    }
    if (test.status === 'passed') {
      assert.ok(Array.isArray(test.errors), 'Original test error inventory is missing');
      if (test.errors.length) failures.push({ testId: test.id, reason: 'Passed status retains unexpected original errors', originalErrors: test.errors });
    }
    assert.equal(test.attemptCount, 1, 'Retries or missing attempts change complete work');
    assert.equal(test.retry, 0);
    for (const [name, value] of Object.entries(expected.observations)) if (!isDeepStrictEqual(test.observations?.[name], value))
      failures.push({ testId: test.id, reason: `Required application observation differs: ${name}` });
    if (expected.outcome === 'intentional-failure') {
      if (!isDeepStrictEqual(test.diagnostics?.identity, expected.diagnosticIdentity) || test.diagnostics?.originalPredicateRetained !== true)
        failures.push({ testId: test.id, reason: 'Original predicate diagnostic is missing or differs; later fallback is insufficient' });
      if (test.diagnostics?.evidence?.length) requireEvidence(test.diagnostics.evidence, 'Malformed original failure artifacts');
      else failures.push({ testId: test.id, reason: 'Missing original failure artifacts' });
    }
  }
  assert.ok(Array.isArray(report.unexpectedErrors), 'Original runner errors must be retained');
  failures.push(...report.unexpectedErrors.map(error => ({ reason: 'Original unexpected runner error', originalError: error })));
  assert.equal(report.runnerExitCode, report.tests.some(test => ['failed', 'timedOut', 'interrupted'].includes(test.status)) || report.unexpectedErrors.length ? 1 : 0);
  // Failed attempts may never create contexts or reach worker execution. Preserve them before success-only admission.
  if (failures.length) return failures;
  for (const test of report.tests) {
    assert.ok(typeof test.contextIdentity === 'string' && test.contextIdentity && !contexts.has(test.contextIdentity), 'Fresh test context was reused or unrecorded');
    contexts.add(test.contextIdentity);
    assert.ok(typeof test.workerIdentity === 'string' && test.workerIdentity, 'Missing original test worker identity');
    usedWorkers.add(test.workerIdentity);
    const worker = workers.get(test.workerIdentity);
    assert.ok(worker && test.interval.startMilliseconds >= worker.startMilliseconds
      && test.interval.endMilliseconds <= worker.endMilliseconds, 'Original test interval escapes its logical worker lifetime');
    testIntervals.push({ identity: test.id, ...test.interval });
  }
  assert.ok(usedWorkers.size >= cell.workers, 'Declared workers did not execute original tests');
  assert.equal(maximumIntervalConcurrency(testIntervals, report.ownerInterval), cell.workers, 'Original tests do not prove actual matched concurrency');
  for (const identity of usedWorkers) {
    const intervals = report.tests.filter(test => test.workerIdentity === identity).map(test => ({ identity: test.id, ...test.interval }));
    assert.equal(maximumIntervalConcurrency(intervals, report.ownerInterval), 1, 'Tests assigned to the same logical worker overlap');
  }
  return failures;
}

/** Derive sampled RSS independently; terminal owner CPU is inclusive and counted exactly once. */
function observedResources(resources, scenario, interval) {
  assert.ok(Array.isArray(resources.ownedProcesses) && resources.ownedProcesses.length, 'Missing original owned process identities');
  assert.ok(Array.isArray(resources.samples) && resources.samples.length, 'Missing original resource samples');
  const owned = new Map();
  for (const process of resources.ownedProcesses) {
    assert.ok(typeof process.namespace === 'string' && process.namespace && Number.isSafeInteger(process.processId) && process.processId > 0
      && typeof process.startIdentity === 'string' && process.startIdentity, 'Missing original process identity');
    assert.equal(process.identity, `${process.namespace}/${process.processId}/${process.startIdentity}`);
    assert.ok(!owned.has(process.identity), 'Duplicate original PID/start identity');
    assert.ok(Array.isArray(process.components) && process.components.length, 'Missing process coverage attribution');
    owned.set(process.identity, process);
  }
  let sampledConcurrentBytes = 0, previousTime = -Infinity;
  for (const sample of resources.samples) {
    assert.ok(Number.isFinite(sample.timestampMilliseconds) && sample.timestampMilliseconds >= previousTime
      && sample.timestampMilliseconds >= resources.captureInterval.startMilliseconds
      && sample.timestampMilliseconds <= resources.captureInterval.endMilliseconds, 'Invalid resource sample interval');
    previousTime = sample.timestampMilliseconds;
    assert.ok(Array.isArray(sample.processes));
    const identities = new Set();
    let concurrentBytes = 0;
    for (const process of sample.processes) {
      assert.ok(owned.has(process.identity) && !identities.has(process.identity), 'Unknown or duplicated resource PID/start identity');
      identities.add(process.identity);
      assert.ok(Number.isSafeInteger(process.residentBytes) && process.residentBytes >= 0, 'Invalid sampled RSS');
      concurrentBytes += process.residentBytes;
      assert.ok(Number.isSafeInteger(concurrentBytes), 'Sampled concurrent RSS overflows');
    }
    sampledConcurrentBytes = Math.max(sampledConcurrentBytes, concurrentBytes);
  }
  requirePositive(sampledConcurrentBytes, 'No observed sampled process-tree RSS');
  const reasons = [];
  assert.ok(Array.isArray(resources.missingRequiredProcessIdentities), 'Collector must retain known missing original identities');
  reasons.push(...resources.missingRequiredProcessIdentities.map(() => 'Collector recorded a missing required original process identity'));
  for (const component of scenario.requiredResourceComponents) if (![...owned.values()].some(process => process.components.includes(component))) reasons.push(`Missing complete resource coverage: ${component}`);
  assert.ok(resources.samples[0].timestampMilliseconds <= interval.startMilliseconds
    && resources.samples.at(-1).timestampMilliseconds >= interval.endMilliseconds, 'Resource samples omit complete clock boundaries');
  return { sampledConcurrentBytes, reasons };
}

function verifyRun(run, engine, scenario, cell, configuration, declaration) {
  const { report, resources } = run;
  requireEvidence(run.evidence, 'Missing retained raw report/resource evidence');
  assert.equal(report.engine, engine);
  assert.equal(report.comparisonClass, configuration.comparisonClass, 'Non-equivalent comparison class');
  assert.equal(report.scenarioId, scenario.id);
  assert.equal(report.cellId, cell.id);
  const identity = report.identity;
  assert.equal(identity.configurationSha256, declaration.configurationSha256);
  assert.equal(identity.platform, configuration.platform);
  assert.equal(identity.architecture, configuration.architecture);
  assert.deepEqual(identity.runtime, configuration.runtime);
  assert.equal(identity.runtimeSha256, declaration.runtimeSha256);
  assert.equal(identity.browserVersion, configuration.browserVersion);
  assert.equal(identity.browserSha256, declaration.browserSha256);
  assert.equal(identity.driverSha256, declaration.driverSha256);
  assert.equal(identity.hostIdentitySha256, declaration.host.identitySha256);
  assert.equal(identity.referenceVersion, configuration.referenceVersion);
  assert.deepEqual(identity.sourceManifest, declaration.sourceManifest);
  assert.deepEqual(identity.dependencyManifest, declaration.dependencyManifest);
  assert.deepEqual(identity.scenarioSourceManifest, scenario.sourceManifest);
  assert.equal(identity.workers, cell.workers);
  assert.deepEqual(identity.artifacts, scenario.artifacts);
  assert.deepEqual(identity.scheduling, scenario.scheduling[cell.id]);
  assert.equal(identity.applicationPolicySha256, scenario.applicationPolicySha256);
  requireHash(scenario.applicationPolicySha256, 'Missing matched application/backend/isolation policy');
  const behaviorFailures = verifyTests(report, resources, scenario, cell);
  const interval = report.ownerInterval;
  assert.ok(Number.isFinite(interval.startMilliseconds) && Number.isFinite(interval.endMilliseconds)
    && interval.endMilliseconds > interval.startMilliseconds, 'Invalid complete owner interval');
  requirePositive(report.completeMilliseconds, 'Invalid complete duration');
  assert.equal(report.completeMilliseconds, interval.endMilliseconds - interval.startMilliseconds, 'Complete clock differs from owner interval');
  assert.equal(report.clockBoundary, configuration.clockBoundary, 'Incomplete clock boundary');
  assert.equal(report.fixtureInitializationInsideClock, true);
  assert.equal(report.allShutdownAndArtifactFlushInsideClock, true);
  assert.equal(resources.collectorSha256, declaration.resourceCollectorSha256);
  assert.ok(resources.captureInterval.startMilliseconds <= interval.startMilliseconds
    && resources.captureInterval.endMilliseconds >= interval.endMilliseconds, 'Resource coverage omits complete owner lifetime');
  assert.equal(resources.ownerExitCode, 0);
  assert.equal(resources.timedOut, false);
  assert.equal(resources.interrupted, false);
  assert.deepEqual(resources.remainingOwnedProcesses, []);
  assert.deepEqual(resources.cleanupSignals, []);
  const observations = observedResources(resources, scenario, interval);
  assert.equal(resources.sampledConcurrentBytes, observations.sampledConcurrentBytes, 'Reported memory differs from retained process samples');
  assert.equal(resources.schemaVersion, 2, 'Final resources require original owner schema 2');
  assert.equal(resources.cpuAccounting, 'atomic-wait4-original-owner', 'Sampled CPU cannot admit final resource comparisons');
  assert.equal(resources.observedProcessTreeCpuSeconds, undefined, 'Legacy sampled CPU cannot be promoted to tree CPU');
  const ownerCpu = resources.originalOwnerCpu;
  assert.equal(ownerCpu?.method, 'atomic-wait4-original-owner');
  assert.equal(ownerCpu.status, 'observed');
  assert.equal(ownerCpu.exitCode, 0);
  assert.equal(ownerCpu.waitStatus, 0);
  assert.ok(resources.ownedProcesses.some(process => process.processId === ownerCpu.process && process.role === 'owner'),
    'Original CPU owner is absent from reconstructed ownership');
  for (const value of [ownerCpu.userSeconds, ownerCpu.systemSeconds]) assert.ok(Number.isFinite(value) && value >= 0);
  assert.equal(ownerCpu.cpuSeconds, ownerCpu.userSeconds + ownerCpu.systemSeconds);
  assert.equal(resources.originalOwnerInclusiveCpuSeconds, ownerCpu.cpuSeconds, 'Reported CPU differs from original owner wait4');
  requirePositive(resources.originalOwnerInclusiveCpuSeconds, 'No original owner CPU');
  if (!behaviorFailures.length) {
    const concurrency = maximumIntervalConcurrency(resources.workerIntervals, interval);
    assert.equal(concurrency, cell.workers, 'Configured worker count does not prove actual matched concurrency');
  }
  for (const worker of resources.workerIntervals) assert.ok(resources.ownedProcesses.some(process => process.identity === worker.hostProcessIdentity
    && process.components.includes('workers')), 'Logical worker host is absent from owned process evidence');
  const reasons = observations.reasons;
  if (resources.sampledConcurrentBytes > configuration.resourcePolicy.maximumSampledConcurrentBytes) reasons.push('Sampled complete tree exceeds the 8 GiB ceiling');
  assert.ok(Array.isArray(report.backgroundConfounds));
  reasons.push(...report.backgroundConfounds.map(() => 'Observed background resource confound'));
  return { reasons, behaviorFailures, interval, report, resources, evidence: run.evidence };
}

/** Admit original receipts only after failed attempts and known coverage gaps remain nonwinners. */
function verifyResourceProvenance(run, declaration, originalResourceIdentities) {
  const { report, resources } = run;
  for (const kind of ['report', 'resources', 'watchdog', 'lifecycle', 'owner-tree'])
    assert.equal(run.evidence.filter(receipt => receipt.kind === kind).length, 1, `Missing unique raw ${kind} file`);
  const watchdogReceipt = run.evidence.find(receipt => receipt.kind === 'watchdog');
  const watchdogClock = finalGoalClockProjection(report.watchdogClock);
  assert.deepEqual(report.watchdogClock, watchdogClock, 'Report must retain the exact original watchdog clock projection');
  assert.deepEqual(resources.watchdogClock, watchdogClock, 'Resource clock differs from original report clock');
  assert.equal(resources.provenance?.clockIdentity, watchdogClock.identity, 'Resource capture identity differs from original clock');
  assert.equal(resources.provenance?.watchdogSha256, watchdogReceipt.sha256, 'Resource watchdog hash differs from original receipt');
  assert.equal(resources.provenance?.hostIdentitySha256, declaration.host.identitySha256, 'Resource host differs from declared host');
  assert.equal(resources.provenance?.lifecycleSourceSha256, declaration.lifecycleProducerSha256,
    'Resource lifecycle producer differs from admitted source');
  assert.deepEqual(resources.ownerInterval, report.ownerInterval, 'Lifecycle owner interval differs from original report');
  assert.equal(resources.provenance.bootIdentitySha256, declaration.host.bootIdentitySha256, 'Resource boot differs from declared boot');
  assert.equal(resources.provenance.sourceManifestSha256, finalGoalHash(declaration.sourceManifest), 'Resource source manifest differs');
  assert.equal(resources.provenance.dependencyManifestSha256, finalGoalHash(declaration.dependencyManifest), 'Resource dependencies differ');
  for (const name of ['runtime', 'browser', 'driver'])
    assert.equal(resources.provenance.executables?.[name]?.sha256, declaration[`${name}Sha256`], `Resource ${name} executable differs`);
  assert.equal(resources.provenance.executables?.launcher?.sha256, declaration.launcherSha256[report.engine], 'Resource launcher differs');
  const capture = resources.provenance.capture;
  assert.equal(capture?.engine, report.engine);
  assert.equal(capture.workers, report.identity.workers);
  assert.equal(capture.clockIdentity, watchdogClock.identity);
  assert.equal(capture.ownerProcess, resources.originalOwnerCpu.process);
  assert.match(capture.session ?? '', /^[a-f0-9]{32}$/);
  requireHash(capture.inventorySha256, 'Missing original owner-tree inventory');
  assert.equal(capture.family, report.scenarioId.replace(/^runner-/, ''), 'Owner capture does not cover this scenario');
  assert.equal(resources.originalRunnerExitCode, report.runnerExitCode, 'Original runner exit differs');
  assert.ok(Array.isArray(resources.originalAttempts), 'Missing original dispatched attempts');
  assert.equal(resources.originalAttempts.length, report.tests.length);
  const originalAttempts = new Map(resources.originalAttempts.map(attempt => [attempt.testId, attempt]));
  assert.equal(originalAttempts.size, report.tests.length);
  for (const test of report.tests) {
    const attempt = originalAttempts.get(test.id);
    assert.ok(attempt, 'Original dispatch is missing for reported test');
    assert.equal(attempt.bodySha256, test.bodySha256, 'Original dispatched callback differs');
    assert.equal(attempt.workerIdentity, test.workerIdentity, 'Original dispatched worker differs');
    assert.equal(attempt.retry, test.retry);
    assert.equal(attempt.status, test.status, 'Original dispatched outcome differs');
    assert.deepEqual(attempt.interval, test.interval, 'Original dispatched interval differs');
  }
  const lifecycleReceipt = run.evidence.find(receipt => receipt.kind === 'lifecycle');
  const treeReceipt = run.evidence.find(receipt => receipt.kind === 'owner-tree');
  for (const [kind, value] of [['path', watchdogReceipt.path], ['path', lifecycleReceipt.path],
    ['watchdogSha256', watchdogReceipt.sha256], ['path', treeReceipt.path], ['captureIdentity', capture.session], ['captureIdentity', watchdogClock.identity]]) {
    assert.ok(!originalResourceIdentities[kind].has(value), `Reused original resource ${kind}`);
    originalResourceIdentities[kind].add(value);
  }
}

function analyzeCell(result, scenario, cell, configuration, declaration, campaignIntervals, originalResourceIdentities) {
  if (!result) return { id: cell.id, status: 'unmeasured', evidenceComplete: false, confirmedWin: false, pointEstimateWin: false, reasons: ['Missing declared cell'] };
  assert.equal(result.id, cell.id);
  assert.ok(['comparable', ...nonwinningStatuses].includes(result.status));
  assert.ok(Array.isArray(result.attempts), 'Attempt inventory is required even for nonwinners');
  const completeRawPairs = result.attempts.length === configuration.independentPairs
    && result.attempts.every(pair => engines.every(engine => Array.isArray(pair.runs?.[engine]?.report?.tests)));
  if (result.status !== 'comparable' && !completeRawPairs) {
    assert.ok(typeof result.reason === 'string' && result.reason, 'Nonwinner needs an explicit reason');
    if (result.status !== 'unmeasured') {
      requireEvidence(result.evidence, 'Nonwinner needs retained attempted evidence');
      assert.ok(result.attempts.length, 'Unsupported/failed/noncomparable label cannot erase original attempts');
      for (const attempt of result.attempts) {
        assert.ok(attempt.failure && typeof attempt.failure.code === 'string' && attempt.failure.code
          && typeof attempt.failure.message === 'string' && attempt.failure.message, 'Nonwinner needs the original attempt failure');
        requireEvidence(attempt.evidence, 'Missing original attempted failure bytes');
      }
    }
    return { id: cell.id, status: result.status, evidenceComplete: result.status !== 'unmeasured', confirmedWin: false,
      pointEstimateWin: false, reasons: [result.reason], retainedAttempts: result.attempts,
      supportedRegression: ['failed', 'unsupported'].includes(result.status) && scenario.previouslySupported?.[cell.id] === true };
  }
  assert.equal(result.attempts.length, configuration.independentPairs, 'Selective or incomplete launch pairs');
  const reasons = [];
  const behaviorFailures = [];
  const runs = { playwright: [], flashwright: [] };
  for (const [index, pair] of result.attempts.entries()) {
    assert.equal(pair.id, `${scenario.id}/${cell.id}/${index}`, 'Relabelled or duplicate pair identity');
    assert.equal(pair.launchIndex, index);
    const order = index % 2 ? ['flashwright', 'playwright'] : engines;
    assert.deepEqual(pair.order, order, 'Engine pair order must alternate');
    assert.deepEqual(Object.keys(pair.runs).sort(), [...engines].sort());
    let previousEnd = -Infinity;
    for (const engine of order) {
      const run = verifyRun(pair.runs[engine], engine, scenario, cell, configuration, declaration);
      assert.ok(run.interval.startMilliseconds >= previousEnd, 'Paired executions overlap');
      previousEnd = run.interval.endMilliseconds;
      campaignIntervals.push({ scenarioId: scenario.id, cellId: cell.id, launchIndex: index, engine, ...run.interval });
      reasons.push(...run.reasons);
      behaviorFailures.push(...run.behaviorFailures.map(failure => ({ engine, launchIndex: index, ...failure })));
      runs[engine].push(run);
    }
  }
  if (behaviorFailures.length) return { id: cell.id, status: 'failed', evidenceComplete: true, confirmedWin: false,
    pointEstimateWin: false, behaviorFailures, reasons: ['Original attempted behavior differs', ...new Set(reasons)], retainedAttempts: result.attempts,
    supportedRegression: scenario.previouslySupported[cell.id] === true };
  if (reasons.length) return { id: cell.id, status: 'noncomparable', evidenceComplete: true, confirmedWin: false,
    pointEstimateWin: false, reasons: [...new Set(reasons)], retainedAttempts: result.attempts };
  assert.equal(result.status, 'comparable', 'Successful comparable raw pairs cannot be relabelled to hide a regression');
  for (const engine of engines) for (const run of runs[engine])
    verifyResourceProvenance(run, declaration, originalResourceIdentities);
  const values = (engine, select) => runs[engine].map(select);
  const complete = comparePaired(values('playwright', run => [run.report.completeMilliseconds]),
    values('flashwright', run => [run.report.completeMilliseconds]), configuration.statistics);
  const ratio = (select, aggregate) => aggregate(values('flashwright', select)) / aggregate(values('playwright', select));
  const median = samples => quantile(samples, 0.5);
  const maximum = samples => Math.max(...samples);
  const regressionRatios = {
    completeMedian: ratio(run => run.report.completeMilliseconds, median),
    completeObservedMaximum: ratio(run => run.report.completeMilliseconds, maximum),
    ...finalGoalResourceRegressionRatios(configuration, Object.fromEntries(engines.map(engine =>
      [engine, runs[engine].map(run => run.resources)]))),
  };
  const regressions = Object.keys(regressionRatios).filter(metric => regressionRatios[metric] > configuration.maximumRegressionRatios[metric]);
  const pointEstimateWin = complete.medianPairedSpeedup >= configuration.minimumSpeedup;
  const confirmedWin = pointEstimateWin && complete.pairedSpeedupConfidenceInterval[0] >= configuration.minimumSpeedup;
  return { id: cell.id, status: confirmedWin ? 'confirmed-win' : pointEstimateWin ? 'uncertain' : 'nonwinner', evidenceComplete: true,
    pointEstimateWin, confirmedWin, complete, regressionRatios, regressions, reasons: [], retainedAttempts: result.attempts };
}

/** Recompute fixed-denominator acceptance; draft or incomplete evidence can never establish the final goal. */
export function analyzeFinalGoal({ configuration, declaration, scenarioResults }) {
  verifyFinalGoalConfiguration(configuration);
  const sealed = verifyDeclaration(configuration, declaration);
  assert.ok(Array.isArray(scenarioResults));
  const results = new Map();
  for (const result of scenarioResults) {
    assert.ok(finalGoalScenarioIds.includes(result.id) && !results.has(result.id), 'Unknown or duplicate scenario');
    results.set(result.id, result);
  }
  const campaignIntervals = [];
  const originalResourceIdentities = { path: new Set(), watchdogSha256: new Set(), captureIdentity: new Set() };
  const scenarios = configuration.scenarios.map(scenario => {
    const result = results.get(scenario.id);
    assert.ok(!result || Array.isArray(result.cells));
    const cells = new Map();
    for (const item of result?.cells ?? []) {
      assert.ok(cellIds.includes(item.id) && !cells.has(item.id), 'Unknown or duplicate resource cell');
      cells.set(item.id, item);
    }
    const analysis = configuration.cells.map(cell => sealed ? analyzeCell(cells.get(cell.id), scenario, cell, configuration, declaration, campaignIntervals, originalResourceIdentities)
      : { id: cell.id, status: 'unsealed', evidenceComplete: false, confirmedWin: false, pointEstimateWin: false, reasons: ['Declaration/configuration remains unsealed'] });
    return { id: scenario.id, kind: scenario.kind, cells: analysis, confirmedWin: analysis.every(cell => cell.confirmedWin),
      pointEstimateWin: analysis.every(cell => cell.pointEstimateWin), evidenceComplete: analysis.every(cell => cell.evidenceComplete) };
  });
  campaignIntervals.sort((left, right) => left.startMilliseconds - right.startMilliseconds);
  for (let index = 1; index < campaignIntervals.length; index++) assert.ok(campaignIntervals[index].startMilliseconds >= campaignIntervals[index - 1].endMilliseconds,
    'Complete owner intervals overlap across scenarios or cells');
  const intervalKey = item => `${item.scenarioId}/${item.cellId}/${item.launchIndex}/${item.engine}`;
  const collectedKeys = new Set(campaignIntervals.map(intervalKey));
  const expectedOrder = [];
  for (let launchIndex = 0; launchIndex < configuration.independentPairs; launchIndex++) {
    const offset = launchIndex % configuration.scenarios.length;
    const order = configuration.scenarios.slice(offset).concat(configuration.scenarios.slice(0, offset));
    for (const scenario of order) for (const cell of configuration.cells)
      for (const engine of launchIndex % 2 ? ['flashwright', 'playwright'] : engines) {
        const key = `${scenario.id}/${cell.id}/${launchIndex}/${engine}`;
        if (collectedKeys.has(key)) expectedOrder.push(key);
      }
  }
  assert.deepEqual(campaignIntervals.map(intervalKey), expectedOrder, 'Campaign intervals do not follow predeclared rotating scenario/pair order');
  const confirmedWins = scenarios.filter(scenario => scenario.confirmedWin).length;
  const pointEstimateWins = scenarios.filter(scenario => scenario.pointEstimateWin).length;
  const applicationWins = scenarios.filter(scenario => scenario.kind === 'application' && scenario.confirmedWin).length;
  const evidenceComplete = sealed && scenarios.every(scenario => scenario.evidenceComplete);
  const regressions = scenarios.flatMap(scenario => scenario.cells.flatMap(cell => (cell.regressions ?? []).map(metric => ({ scenarioId: scenario.id, cellId: cell.id, metric }))));
  const supportedRegressions = scenarios.flatMap(scenario => scenario.cells.filter(cell => cell.supportedRegression).map(cell => ({ scenarioId: scenario.id, cellId: cell.id })));
  const requiredMajority = Math.floor(configuration.scenarios.length / 2) + 1;
  const goalAccepted = evidenceComplete && confirmedWins >= requiredMajority && applicationWins >= configuration.minimumApplicationWins
    && !regressions.length && !supportedRegressions.length;
  return structuredClone({ schemaVersion: 1, sealed, configurationSha256: declaration.configurationSha256,
    declaredScenarioCount: configuration.scenarios.length, requiredMajority, confirmedWins, pointEstimateWins, applicationWins,
    evidenceComplete, regressions, supportedRegressions, goalAccepted, competitorLeadershipEstablished: false, scenarios, campaignIntervals,
    scope: finalGoalPlatformScope(configuration) });
}

/** Keep every declared scenario and resource cell visible without exposing raw private evidence paths. */
export function renderFinalGoalReport(analysis) {
  const lines = ['Final-goal matrix.', '', `Acceptance: ${analysis.goalAccepted ? 'passed within the declared scope' : 'not established'}.`,
    `${analysis.confirmedWins}/${analysis.declaredScenarioCount} confirmed distinct wins; required majority ${analysis.requiredMajority}. Application wins: ${analysis.applicationWins}/3; required 2. Point-estimate wins: ${analysis.pointEstimateWins}.`, '',
    '| Scenario | Cell | Status | Paired median speedup | 95% interval | Regressions |', '| --- | --- | --- | ---: | --- | --- |'];
  for (const scenario of analysis.scenarios) for (const cell of scenario.cells) lines.push(`| ${scenario.id} | ${cell.id} | ${cell.status} | ${cell.complete?.medianPairedSpeedup.toFixed(3) ?? 'unavailable'} | ${cell.complete?.pairedSpeedupConfidenceInterval.map(value => value.toFixed(3)).join('–') ?? 'unavailable'} | ${(cell.regressions ?? []).join(', ') || (cell.supportedRegression ? 'supported behavior regression' : 'none measured')} |`);
  lines.push('', `Evidence complete: ${analysis.evidenceComplete}. Numeric regression vetoes: ${analysis.regressions.length}. Supported behavior regression vetoes: ${analysis.supportedRegressions.length}.`, '', analysis.scope, '', 'This gate does not establish competitor leadership. All raw attempts and explicit noncomparability reasons remain in the retained machine-readable analysis.', '');
  return lines.join('\n');
}
