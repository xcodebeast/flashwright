import assert from 'node:assert/strict';

export const finalGoalAccountingClasses = Object.freeze({
  darwin: 'atomic-wait4-original-owner-and-sampled-rss-v1',
  linux: 'linux-cgroup-v2-charged-scope-v1',
});

/** Historical macOS declarations predate an explicit accounting-class field. */
export function finalGoalAccountingClass(configuration) {
  if (configuration.platform === 'darwin') {
    assert.equal(configuration.architecture, 'arm64');
    assert.equal(configuration.accountingClass ?? finalGoalAccountingClasses.darwin, finalGoalAccountingClasses.darwin);
    return finalGoalAccountingClasses.darwin;
  }
  assert.equal(configuration.platform, 'linux', 'Unsupported final campaign platform');
  assert.equal(configuration.architecture, 'x64');
  assert.equal(configuration.accountingClass, finalGoalAccountingClasses.linux, 'Linux requires its distinct accounting class');
  return finalGoalAccountingClasses.linux;
}

/** Validate units and budgets without promoting diagnostic capture into admission. */
export function verifyFinalGoalResourcePolicy(configuration) {
  const accountingClass = finalGoalAccountingClass(configuration);
  if (accountingClass === finalGoalAccountingClasses.darwin) {
    assert.deepEqual(configuration.resourcePolicy, { logicalCpuCount: 11, physicalMemoryBytes: 36 * 1024 ** 3,
      maximumSampledConcurrentBytes: 8 * 1024 ** 3, operatingSystemEnforcedLimits: false });
    assert.deepEqual(configuration.maximumRegressionRatios, { completeMedian: 1.05, completeObservedMaximum: 1.15,
      sampledConcurrentMemoryMaximum: 1.10, originalOwnerInclusiveCpuMedian: 1.10 });
    return;
  }
  const { logicalCpuCount, physicalMemoryBytes } = configuration.resourcePolicy ?? {};
  assert(Number.isSafeInteger(logicalCpuCount) && logicalCpuCount >= 4, 'Linux host needs at least four online CPUs');
  assert(Number.isSafeInteger(physicalMemoryBytes) && physicalMemoryBytes >= 8 * 1024 ** 3, 'Invalid Linux physical memory inventory');
  assert.deepEqual(configuration.resourcePolicy, { logicalCpuCount, physicalMemoryBytes,
    cpuMax: { quotaMicroseconds: 400000, periodMicroseconds: 100000 },
    maximumCgroupChargedBytes: 8 * 1024 ** 3, maximumSwapBytes: 0, operatingSystemEnforcedLimits: true });
  assert.deepEqual(configuration.maximumRegressionRatios, { completeMedian: 1.05, completeObservedMaximum: 1.15,
    cgroupChargedMemoryMaximum: 1.10, cgroupCpuUsageMedian: 1.10 });
}

export function finalGoalPlatformScope(configuration) {
  const accountingClass = finalGoalAccountingClass(configuration);
  const platform = accountingClass === finalGoalAccountingClasses.linux
    ? 'Native Linux x64; cgroup usage CPU and charged memory, not wait4 CPU or sampled RSS. Linux resource reconstruction and campaign admission remain open.'
    : 'Native macOS arm64; original-owner wait4 CPU and sampled concurrent RSS. Native Linux remains separately open.';
  return `${platform} Matched Bun 1.4.2 and pinned Chrome; one/four observed workers required. Eight independent pairs per cell; observed maxima, not percentile tails. Per-cell 95% intervals do not establish simultaneous 95% majority confidence.`;
}
