import assert from 'node:assert/strict';
import { quantile } from './statistics.mjs';

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

function counter(value, name) {
  assert(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), `Invalid ${name} counter`);
  const number = Number(value);
  assert(Number.isSafeInteger(number), `${name} counter exceeds exact numeric range`);
  return number;
}

/** Project independently reconstructed observations, without granting resource admission. */
export function finalGoalResourceMetrics(configuration, resources) {
  const accountingClass = finalGoalAccountingClass(configuration);
  assert.equal(resources.accountingClass ?? finalGoalAccountingClasses.darwin, accountingClass,
    'Resource accounting class differs from campaign');
  if (accountingClass === finalGoalAccountingClasses.linux) {
    assert.equal(resources.schemaVersion, 1);
    assert.equal(resources.status, 'verified-local-observations');
    assert.equal(resources.resourceAdmission, false);
    assert.equal(resources.performanceAccepted, false);
    for (const name of ['sampledConcurrentBytes', 'originalOwnerInclusiveCpuSeconds', 'observedProcessTreeCpuSeconds', 'cpuAccounting'])
      assert.equal(resources[name], undefined, `Linux observations cannot contain ${name}`);
    // usage_usec is the kernel total. Neither user+system nor inclusive waits replace it.
    return {
      cgroupCpuUsageMicroseconds: counter(resources.cgroupCpu?.usageMicroseconds, 'cgroup CPU usage'),
      cgroupChargedPeakBytes: counter(resources.cgroupChargedPeakBytes, 'cgroup charged memory'),
    };
  }
  assert.equal(resources.schemaVersion, 2);
  assert.equal(resources.cpuAccounting, 'atomic-wait4-original-owner');
  for (const name of ['cgroupCpu', 'cgroupChargedPeakBytes'])
    assert.equal(resources[name], undefined, `macOS observations cannot contain ${name}`);
  assert(Number.isFinite(resources.originalOwnerInclusiveCpuSeconds) && resources.originalOwnerInclusiveCpuSeconds >= 0,
    'Invalid original owner CPU');
  assert(Number.isSafeInteger(resources.sampledConcurrentBytes) && resources.sampledConcurrentBytes >= 0, 'Invalid sampled RSS');
  return { originalOwnerInclusiveCpuSeconds: resources.originalOwnerInclusiveCpuSeconds,
    sampledConcurrentBytes: resources.sampledConcurrentBytes };
}

/** Ratio of CPU medians and ratio of memory maxima; not medians of paired ratios. */
export function finalGoalResourceRegressionRatios(configuration, resources) {
  verifyFinalGoalResourcePolicy(configuration);
  assert.deepEqual(Object.keys(resources).sort(), ['flashwright', 'playwright']);
  assert(Array.isArray(resources.playwright) && resources.playwright.length > 0
    && Array.isArray(resources.flashwright) && resources.flashwright.length === resources.playwright.length,
  'Resource comparisons require matched nonempty launch inventories');
  const linux = finalGoalAccountingClass(configuration) === finalGoalAccountingClasses.linux;
  const observations = {};
  for (const engine of ['playwright', 'flashwright']) {
    observations[engine] = resources[engine].map(resource => {
      if (linux) {
        assert.equal(resource.wrapperExitCode, 0, 'Failed Linux workloads cannot supply comparison ratios');
        assert.equal(resource.observedDrainedMembership, true, 'Undrained Linux workloads cannot supply comparison ratios');
        assert.deepEqual(resource.drainRejectionReasons, []);
      }
      return finalGoalResourceMetrics(configuration, resource);
    });
  }
  const metrics = linux
    ? [['cgroupChargedMemoryMaximum', 'cgroupChargedPeakBytes', values => Math.max(...values)],
      ['cgroupCpuUsageMedian', 'cgroupCpuUsageMicroseconds', values => quantile(values, 0.5)]]
    : [['sampledConcurrentMemoryMaximum', 'sampledConcurrentBytes', values => Math.max(...values)],
      ['originalOwnerInclusiveCpuMedian', 'originalOwnerInclusiveCpuSeconds', values => quantile(values, 0.5)]];
  return Object.fromEntries(metrics.map(([name, field, aggregate]) => {
    const reference = aggregate(observations.playwright.map(row => row[field]));
    const candidate = aggregate(observations.flashwright.map(row => row[field]));
    assert(reference > 0, `No positive reference observation for ${name}`);
    return [name, candidate / reference];
  }));
}

export function finalGoalPlatformScope(configuration) {
  const accountingClass = finalGoalAccountingClass(configuration);
  const platform = accountingClass === finalGoalAccountingClasses.linux
    ? 'Native Linux x64; cgroup usage CPU and charged memory, not wait4 CPU or sampled RSS. Linux resource reconstruction and campaign admission remain open.'
    : 'Native macOS arm64; original-owner wait4 CPU and sampled concurrent RSS. Native Linux remains separately open.';
  return `${platform} Matched Bun 1.4.2 and pinned Chrome; one/four observed workers required. Eight independent pairs per cell; observed maxima, not percentile tails. Per-cell 95% intervals do not establish simultaneous 95% majority confidence.`;
}
