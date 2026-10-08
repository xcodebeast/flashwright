import assert from 'node:assert/strict';
import { comparePaired } from './statistics.mjs';

const orders = [
  ['playwright', 'flashwright-off', 'flashwright-on'],
  ['flashwright-off', 'flashwright-on', 'playwright'],
  ['flashwright-on', 'playwright', 'flashwright-off'],
  ['playwright', 'flashwright-on', 'flashwright-off'],
  ['flashwright-on', 'flashwright-off', 'playwright'],
  ['flashwright-off', 'playwright', 'flashwright-on'],
];

export function residentLoadScenarios(configuration) {
  return configuration.workloads.flatMap(workload => configuration.conditionCounts.map(conditionCount => ({ workload, conditionCount })));
}

/** All six engine orders occur for every scenario; scenario order rotates across groups. */
export function residentLoadPlan(configuration) {
  assert.equal(configuration.independentLaunchGroups, orders.length);
  const scenarios = residentLoadScenarios(configuration);
  return orders.flatMap((order, launchGroup) => scenarios.flatMap((_, offset) => {
    const scenario = scenarios[(offset + launchGroup) % scenarios.length];
    return order.map(mode => ({ launchGroup, scenario, mode }));
  }));
}

/** Preserve the metric's units when using the common launch-level paired bootstrap. */
function compareMetric(reference, candidate, extract, unit, statistics) {
  const comparison = comparePaired(reference.map(record => [extract(record)]), candidate.map(record => [extract(record)]), statistics);
  return { unit, independentPairs: reference.length,
    referenceValues: comparison.reference.launchMedians, candidateValues: comparison.candidate.launchMedians,
    referenceMedian: comparison.reference.medianMilliseconds, candidateMedian: comparison.candidate.medianMilliseconds,
    referenceObservedMaximum: comparison.reference.observedMaximumMilliseconds, candidateObservedMaximum: comparison.candidate.observedMaximumMilliseconds,
    pairedReferenceOverCandidate: comparison.speedupRatios, medianReferenceOverCandidate: comparison.medianPairedSpeedup,
    confidenceInterval: comparison.pairedSpeedupConfidenceInterval };
}

/** Summarize complete matched groups without claiming percentile tails from six observations. */
export function summarizeResidentLoad(launches, configuration) {
  return residentLoadScenarios(configuration).map(scenario => {
    const records = mode => launches.filter(record => record.mode === mode && record.scenario.workload === scenario.workload && record.scenario.conditionCount === scenario.conditionCount)
      .sort((left, right) => left.launchGroup - right.launchGroup);
    const comparisons = [
      ['playwright', 'flashwright-on'], ['flashwright-off', 'flashwright-on'], ['playwright', 'flashwright-off'],
    ].map(([referenceMode, candidateMode]) => {
      const reference = records(referenceMode);
      const candidate = records(candidateMode);
      for (const group of [reference, candidate]) assert.deepEqual(group.map(record => record.launchGroup), Array.from({ length: configuration.independentLaunchGroups }, (_, index) => index));
      const compare = (extract, unit) => compareMetric(reference, candidate, extract, unit, configuration.statistics);
      const metrics = {
        completeTime: compare(record => record.completeMilliseconds, 'milliseconds'),
        operationTime: compare(record => record.operationMilliseconds, 'milliseconds'),
        preparationTime: compare(record => record.preparationMilliseconds, 'milliseconds'),
        processWallTime: compare(record => record.processWallMilliseconds, 'milliseconds'),
        observedCpuTime: compare(record => record.resources.observedCpuSeconds * 1000, 'cpu-milliseconds'),
        peakSampledMemory: compare(record => record.resources.maximumSampledConcurrentRssBytes, 'bytes'),
        maximumApplicationTaskGap: compare(record => Math.max(...record.observations.taskIntervalsMilliseconds), 'milliseconds'),
      };
      // This includes the final public observation call and is an upper bound, not exact detection latency.
      const detectionLagUpperBounds = Object.fromEntries([[referenceMode, reference], [candidateMode, candidate]].map(([mode, group]) =>
        [mode, group.map(record => record.observations.observedAt - record.observations.readyAt)]));
      const gate = {
        cpu: metrics.observedCpuTime.medianReferenceOverCandidate >= 1 / (1 + configuration.acceptance.maximumCpuGrowthFraction),
        memory: metrics.peakSampledMemory.medianReferenceOverCandidate >= 1 / (1 + configuration.acceptance.maximumMemoryGrowthFraction),
        completeTime: metrics.completeTime.medianReferenceOverCandidate >= 1 / (1 + configuration.acceptance.maximumCompleteTimeGrowthFraction),
      };
      return { referenceMode, candidateMode, metrics, detectionLagUpperBounds, gate, passed: Object.values(gate).every(Boolean) };
    });
    return { scenario, comparisons };
  });
}
