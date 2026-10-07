export function quantile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

/** Bootstrap launches, not correlated operations within one browser launch. */
export function summarize(launchSamples, policy) {
  const values = launchSamples.flat();
  const launchMedians = launchSamples.filter(samples => samples.length).map(samples => quantile(samples, 0.5));
  let state = policy.seed;
  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const replicates = [];
  for (let index = 0; index < policy.bootstrapReplicates && launchMedians.length; index++) {
    replicates.push(quantile(launchMedians.map(() => launchMedians[Math.floor(random() * launchMedians.length)]), 0.5));
  }
  const probability = (1 - policy.confidenceLevel) / 2;
  return {
    sampleCount: values.length, independentLaunchCount: launchMedians.length,
    medianMilliseconds: quantile(values, 0.5), launchMedianMilliseconds: quantile(launchMedians, 0.5),
    launchMedianConfidenceInterval: [quantile(replicates, probability), quantile(replicates, 1 - probability)],
    observedMaximumMilliseconds: values.length ? Math.max(...values) : null,
    p95Milliseconds: values.length >= policy.minimumSamplesForP95 ? quantile(values, 0.95) : null,
    p99Milliseconds: values.length >= policy.minimumSamplesForP99 ? quantile(values, 0.99) : null,
    launchMedians,
  };
}

/** Pair launch medians before resampling so alternating engine order remains an independent unit. */
export function comparePaired(referenceSamples, candidateSamples, policy) {
  if (referenceSamples.length !== candidateSamples.length || !referenceSamples.length || [...referenceSamples, ...candidateSamples].some(samples => !samples.length || samples.some(value => !Number.isFinite(value) || value <= 0))) throw new Error('Paired comparisons require complete positive samples for every launch');
  const reference = summarize(referenceSamples, policy);
  const candidate = summarize(candidateSamples, policy);
  const speedupRatios = reference.launchMedians.map((value, index) => value / candidate.launchMedians[index]);
  const ratios = summarize(speedupRatios.map(value => [value]), policy);
  return {
    reference, candidate, speedupRatios,
    medianPairedSpeedup: ratios.launchMedianMilliseconds,
    pairedSpeedupConfidenceInterval: ratios.launchMedianConfidenceInterval,
    observedMaximumRatio: candidate.observedMaximumMilliseconds / reference.observedMaximumMilliseconds,
  };
}
