import assert from 'node:assert/strict';
import { verifyFinalGoalOwnerTree } from './final-goal-owner-tree.mjs';
import { finalGoalClockProjection } from './final-goal-clock-projection.mjs';

const hashPattern = /^[a-f0-9]{64}$/;
const milliseconds = nanoseconds => Number(BigInt(nanoseconds)) / 1e6;

/** Project only reconstructed controlled owners; caller labels cannot create database or mail custody. */
function componentsFor(role, engine) {
  switch (role) {
    case 'owner': return ['fixture-backend'];
    case 'runner': return ['runner'];
    case 'worker': return engine === 'playwright' ? ['workers', 'driver'] : ['workers'];
    case 'driver': case 'guardian': return ['driver'];
    case 'browser': case 'native-child': return ['browser'];
    default: assert.fail(`Unknown reconstructed process role: ${role}`);
  }
}

/** Bind capture metadata to raw observations. Authentic source/host/executable admission remains external. */
function verifyCaptureBindings(lifecycle, tree, plan) {
  assert.equal(lifecycle?.schemaVersion, 2, 'Original owner resources require capture binding schema 2');
  assert.deepEqual(Object.keys(lifecycle).sort(), ['capture', 'executables', 'host', 'provenance', 'schemaVersion']);
  for (const key of ['sourceSha256', 'watchdogSha256', 'sourceManifestSha256', 'dependencyManifestSha256'])
    assert.match(lifecycle.provenance?.[key] ?? '', hashPattern, `Missing capture ${key}`);
  assert.equal(lifecycle.provenance.watchdogSha256, tree.provenance.rawInputs.fixed.watchdog.sha256);
  for (const key of ['identitySha256', 'bootIdentitySha256']) assert.match(lifecycle.host?.[key] ?? '', hashPattern);
  assert.equal(lifecycle.host.namespace, `${lifecycle.host.identitySha256}:${lifecycle.host.bootIdentitySha256}`,
    'Process namespace must bind the original host and boot');
  assert.deepEqual(lifecycle.capture, {
    engine: tree.provenance.engine, family: tree.provenance.family, workers: tree.provenance.workers,
    session: tree.provenance.session, ownerProcess: tree.provenance.ownerProcess,
    clockIdentity: tree.provenance.clockIdentity, inventorySha256: tree.provenance.inventorySha256,
  }, 'Capture bindings differ from original owner tree');
  assert.deepEqual(Object.keys(lifecycle.executables).sort(), ['browser', 'driver', 'launcher', 'runtime']);
  for (const executable of Object.values(lifecycle.executables)) {
    assert.match(executable.sha256 ?? '', hashPattern);
    assert.equal(typeof executable.path, 'string');
  }
  assert.equal(lifecycle.executables.browser.path, plan.nativeBrowserExecutable);
  assert.equal(lifecycle.executables.driver.path, plan.driverExecutable);
  assert.equal(lifecycle.executables.launcher.path, plan.browserExecutable);
  for (const process of tree.ownedProcesses.filter(process => ['owner', 'runner', 'worker'].includes(process.role)))
    assert.equal(process.executablePath, lifecycle.executables.runtime.path, 'Original runtime executable path differs');
}

/** Reconstruct original CPU custody and sampled RSS from raw files, never supplied ownership summaries. */
export function adaptFinalGoalResources({ ownerTreeEvidence, lifecycle, collectorSha256, requiredResourceComponents }) {
  assert.match(collectorSha256 ?? '', hashPattern);
  assert(Array.isArray(requiredResourceComponents) && requiredResourceComponents.length > 0
    && new Set(requiredResourceComponents).size === requiredResourceComponents.length);
  assert(requiredResourceComponents.every(component => typeof component === 'string' && component.length > 0));
  const tree = verifyFinalGoalOwnerTree(ownerTreeEvidence);
  const watchdog = JSON.parse(ownerTreeEvidence.watchdogReportBytes.toString());
  const plan = JSON.parse(ownerTreeEvidence.planBytes.toString());
  verifyCaptureBindings(lifecycle, tree, plan);
  const namespace = lifecycle.host.namespace;
  const ownedProcesses = tree.ownedProcesses.map(process => {
    // Native birth ticks identify unsampled children too. Coarse ps tokens remain census diagnostics.
    const startIdentity = process.startTicks;
    return { identity: `${namespace}/${process.process}/${startIdentity}`, namespace,
      processId: process.process, startIdentity, parentProcessId: process.parent, role: process.role,
      startNanoseconds: process.start, endNanoseconds: process.end,
      components: componentsFor(process.role, plan.engine) };
  });
  const byProcess = new Map(ownedProcesses.map(process => [process.processId, process]));
  const origin = milliseconds(watchdog.clock.originNanoseconds);
  const samples = watchdog.samples.map(sample => ({ timestampMilliseconds: origin + sample.elapsedSeconds * 1000,
    ...(sample.processes.length ? {
      acquisitionStartedMilliseconds: origin + sample.acquisitionStartedElapsedSeconds * 1000,
      acquisitionFinishedMilliseconds: origin + sample.acquisitionFinishedElapsedSeconds * 1000,
    } : {}),
    processes: sample.processes.map(process => ({ identity: byProcess.get(process.process).identity,
      residentBytes: process.rssBytes, sampledCpuSeconds: process.cpuSeconds })) }));
  const workers = new Map();
  const originalAttempts = tree.workerIntervals.map(attempt => {
    const host = byProcess.get(attempt.process);
    const identity = `${host.identity}/worker/${attempt.workerIndex}`;
    const interval = { startMilliseconds: milliseconds(attempt.start), endMilliseconds: milliseconds(attempt.finish) };
    const worker = workers.get(identity);
    if (worker) {
      worker.startMilliseconds = Math.min(worker.startMilliseconds, interval.startMilliseconds);
      worker.endMilliseconds = Math.max(worker.endMilliseconds, interval.endMilliseconds);
    } else workers.set(identity, { identity, hostProcessIdentity: host.identity, ...interval });
    return { testId: attempt.testId, bodySha256: attempt.callbackSha256, workerIdentity: identity,
      attemptIdentity: attempt.attemptIdentity, retry: attempt.retry, status: attempt.status, interval };
  });
  const missingRequiredComponents = requiredResourceComponents.filter(component =>
    !ownedProcesses.some(process => process.components.includes(component)));
  return {
    schemaVersion: 2, cpuAccounting: 'atomic-wait4-original-owner', collectorSha256,
    ownerExitCode: watchdog.exitCode, timedOut: watchdog.timedOut, interrupted: watchdog.interrupted,
    watchdogClock: finalGoalClockProjection(watchdog.clock),
    ownerInterval: { startMilliseconds: origin + watchdog.ownerLaunch.startedElapsedSeconds * 1000,
      endMilliseconds: milliseconds(watchdog.rootPollCpu.reapedNanoseconds) },
    captureInterval: { startMilliseconds: origin, endMilliseconds: origin + watchdog.elapsedSeconds * 1000 },
    ownedProcesses, workerIntervals: [...workers.values()], originalAttempts, samples,
    originalRunnerExitCode: JSON.parse(ownerTreeEvidence.ownerReportBytes.toString()).runnerExit.code,
    originalOwnerInclusiveCpuSeconds: tree.originalOwnerInclusiveCpuSeconds,
    originalOwnerCpu: structuredClone(watchdog.rootPollCpu), sampledConcurrentBytes: tree.sampledConcurrentBytes,
    missingRequiredProcessIdentities: [], remainingOwnedProcesses: [], cleanupSignals: [],
    provenance: { watchdogSha256: tree.provenance.rawInputs.fixed.watchdog.sha256,
      lifecycleSourceSha256: lifecycle.provenance.sourceSha256,
      hostIdentitySha256: lifecycle.host.identitySha256, bootIdentitySha256: lifecycle.host.bootIdentitySha256,
      sourceManifestSha256: lifecycle.provenance.sourceManifestSha256,
      dependencyManifestSha256: lifecycle.provenance.dependencyManifestSha256,
      executables: structuredClone(lifecycle.executables), clockIdentity: tree.provenance.clockIdentity,
      capture: structuredClone(lifecycle.capture), rawInputs: tree.provenance.rawInputs },
    coverage: { missingRequiredComponents, sampledBoundaryObservations: tree.provenance.sampledBoundaryObservations,
      unsampledOwnedProcesses: tree.provenance.unsampledOwnedProcesses.map(process => byProcess.get(process).identity),
      limitations: tree.limitations },
  };
}
