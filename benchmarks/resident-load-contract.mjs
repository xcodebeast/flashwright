import assert from 'node:assert/strict';
import { launchArguments } from './paired-contract.mjs';

export const loadModes = ['playwright', 'flashwright-off', 'flashwright-on'];

export function loadEngineConfiguration(mode, diagnostic = false) {
  return { residentAssertions: mode === 'flashwright-on', conditionInstrumentation: diagnostic };
}

export function loadExecutionBudget(configuration, functionalConformance = false) {
  return functionalConformance ? configuration.functionalConformance : {
    assertionTimeoutMilliseconds: configuration.assertionTimeoutMilliseconds, watchdogTimeoutMilliseconds: 45000,
  };
}

/** Require fixed application work, complete public assertions and independently sampled resources. */
export function verifyResidentLoad(result, configuration, launchPolicy, executablePath, diagnostic = false, functionalConformance = false) {
  assert.equal(result.resources.timeoutSeconds, loadExecutionBudget(configuration, functionalConformance).watchdogTimeoutMilliseconds / 1000);
  if (configuration.functionalConformance) {
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.executionPurpose, functionalConformance ? 'functional-conformance' : 'comparison');
    assert.equal(result.assertionTimeoutMilliseconds, loadExecutionBudget(configuration, functionalConformance).assertionTimeoutMilliseconds);
  } else {
    // Retained pre-profile comparisons used the same fixed production deadline.
    assert.equal(functionalConformance, false);
    assert.equal(result.schemaVersion, undefined);
  }
  assert.ok(loadModes.includes(result.mode));
  assert.equal(result.engine, result.mode === 'playwright' ? 'playwright' : 'flashwright');
  assert.deepEqual(result.engineConfiguration, loadEngineConfiguration(result.mode, diagnostic));
  assert.equal(result.processExit.code, 0);
  assert.equal(result.processExit.signal, null);
  assert.equal(result.browserVersion, configuration.browserVersion);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(launchArguments(result.diagnostics, result.engine, executablePath), configuration.headless ? launchPolicy.headless : launchPolicy.headed);
  const { workload, conditionCount } = result.scenario;
  assert.ok(configuration.workloads.includes(workload));
  assert.ok(configuration.conditionCounts.includes(conditionCount));
  assert.ok(Number.isInteger(result.launchGroup) && result.launchGroup >= 0);
  assert.equal(result.warmupAssertions, 1);
  assert.equal(result.assertionsStarted, conditionCount);
  assert.equal(result.assertionsCompleted, conditionCount);
  for (const name of ['launchMilliseconds', 'preparationMilliseconds', 'operationMilliseconds', 'cleanupMilliseconds', 'completeMilliseconds', 'processWallMilliseconds']) {
    assert.ok(Number.isFinite(result[name]) && result[name] > 0, name);
  }
  assert.ok(result.preparationMilliseconds >= result.launchMilliseconds);
  assert.ok(result.completeMilliseconds >= result.preparationMilliseconds + result.operationMilliseconds + result.cleanupMilliseconds);
  assert.ok(result.processWallMilliseconds >= result.completeMilliseconds);
  const observations = result.observations;
  assert.equal(observations.error, null);
  assert.equal(observations.tasks, configuration.applicationTasks);
  assert.equal(observations.mutations, workload === 'mutation-text' ? configuration.applicationTasks * configuration.mutationsPerTask : 0);
  assert.equal(observations.taskIntervalsMilliseconds.length, configuration.applicationTasks);
  assert.ok(observations.taskIntervalsMilliseconds.every(value => Number.isFinite(value) && value > 0));
  for (const name of ['startedAt', 'lastTaskAt', 'backendAt', 'readyAt', 'observedAt']) assert.ok(Number.isFinite(observations[name]) && observations[name] > 0, name);
  assert.ok(observations.lastTaskAt > observations.startedAt);
  assert.ok(observations.backendAt > observations.startedAt);
  assert.ok(observations.readyAt >= Math.max(observations.lastTaskAt, observations.backendAt));
  assert.ok(observations.observedAt >= observations.readyAt);
  assert.equal(observations.elementCount, configuration.elementCount);
  assert.equal(observations.afterCount, conditionCount);
  assert.equal(observations.beforeCount, configuration.elementCount - conditionCount);
  assert.deepEqual(observations.targetValues, Array(conditionCount).fill('after'));
  assert.deepEqual(result.backend, { documents: 1, backendRequests: 1, otherRequests: 0 });
  verifyObservedResources(result.resources);
  if (diagnostic) {
    assert.equal(result.mode, 'flashwright-on');
    assert.ok(result.diagnosticScope.includes('not production comparison'));
    const metrics = result.conditionMetrics;
    for (const name of ['activeConditions', 'observedRoots', 'queuedConditions', 'queuedDiscovery', 'cachedSelectorPrefixes']) assert.equal(metrics[name], 0, name);
    for (const name of ['animationFrameScheduled', 'deadlineTimerScheduled', 'discoveryTimerScheduled', 'fallbackTimerScheduled', 'flushChannelOpen', 'flushMicrotaskScheduled', 'flushTaskScheduled', 'selectorBatchActive']) assert.equal(metrics[name], false, name);
    assert.ok(metrics.predicateEvaluations >= conditionCount + 2);
    assert.ok(metrics.discoveryPasses > 0 && metrics.discoveryVisits > 0);
    assert.equal(metrics.fallbackChecks, metrics.animationFrameChecks + metrics.timerFallbackChecks);
  } else {
    assert.equal(result.conditionMetrics, undefined);
    assert.equal(result.diagnosticScope, undefined);
  }
}

/** Recompute totals from raw observations, rather than trusting a duplicated summary. */
export function verifyObservedResources(resources) {
  assert.equal(resources.schemaVersion, 2);
  assert.equal(resources.cpuAccounting, 'maximum-per-observed-process-identity');
  assert.equal(resources.exitCode, 0);
  assert.equal(resources.timedOut, false);
  assert.equal(resources.interrupted, false);
  assert.deepEqual(resources.remainingObservedProcesses, []);
  assert.deepEqual(resources.cleanupSignals, []);
  assert.equal(resources.samplingIntervalSeconds, 0.1);
  assert.ok(resources.coverage.includes('not an exact kernel tree accounting'));
  assert.ok(resources.processes.length > 0);
  assert.equal(resources.observedProcessCount, resources.processes.length);
  const identity = process => JSON.stringify([process.process, process.started]);
  assert.equal(new Set(resources.processes.map(identity)).size, resources.processes.length);
  for (const process of resources.processes) {
    assert.ok(Number.isInteger(process.process) && process.process > 0);
    assert.ok(typeof process.started === 'string' && process.started.length > 0);
    assert.ok(Number.isFinite(process.cpuSeconds) && process.cpuSeconds >= 0);
  }
  // Python's compensated sum and JavaScript's sequential sum can differ below one nanosecond.
  const accumulatedCpuSeconds = resources.processes.reduce((total, process) => total + process.cpuSeconds, 0);
  assert.ok(Math.abs(resources.observedCpuSeconds - accumulatedCpuSeconds) < 1e-9, 'CPU total differs from retained process records');
  assert.ok(resources.observedCpuSeconds > 0);
  assert.ok(resources.samples.length > 0);
  let previous = 0;
  const observedCpuByIdentity = new Map();
  for (const sample of resources.samples) {
    assert.ok(Number.isFinite(sample.elapsedSeconds) && sample.elapsedSeconds >= previous);
    assert.ok(Number.isInteger(sample.concurrentRssBytes) && sample.concurrentRssBytes >= 0);
    assert.ok(Number.isInteger(sample.liveOwnedProcesses) && sample.liveOwnedProcesses >= 0);
    assert.equal(sample.liveOwnedProcesses, sample.processes.length);
    assert.equal(new Set(sample.processes.map(identity)).size, sample.processes.length);
    assert.equal(sample.concurrentRssBytes, sample.processes.reduce((total, process) => total + process.rssBytes, 0));
    for (const process of sample.processes) {
      assert.ok(Number.isInteger(process.process) && process.process > 0);
      assert.ok(typeof process.started === 'string' && process.started.length > 0);
      assert.ok(Number.isFinite(process.cpuSeconds) && process.cpuSeconds >= 0);
      assert.ok(Number.isInteger(process.rssBytes) && process.rssBytes >= 0);
      const key = identity(process);
      observedCpuByIdentity.set(key, Math.max(observedCpuByIdentity.get(key) ?? 0, process.cpuSeconds));
    }
    previous = sample.elapsedSeconds;
  }
  assert.equal(observedCpuByIdentity.size, resources.processes.length);
  for (const process of resources.processes) assert.equal(process.cpuSeconds, observedCpuByIdentity.get(identity(process)), 'Reported process CPU differs from its raw observation maximum');
  assert.equal(resources.maximumSampledConcurrentRssBytes, Math.max(...resources.samples.map(sample => sample.concurrentRssBytes)));
  assert.ok(resources.maximumSampledConcurrentRssBytes > 0);
}
