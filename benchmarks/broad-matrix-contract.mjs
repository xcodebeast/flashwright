import assert from 'node:assert/strict';
import { summarize } from './statistics.mjs';
import { verifyLaunch } from './paired-contract.mjs';
import { verifyPuppeteerAdmission, verifyWebdriverAdmission, verifyPuppeteerSample, verifyWebdriverSample } from './competitor-contract.mjs';
import { verifyCypressOutcomeAdmission } from './cypress-contract.mjs';

export const broadEngines = ['flashwright', 'playwright', 'puppeteer', 'cypress', 'webdriverio'];

/** Rotate the full set while alternating reference/candidate order in each launch group. */
export function broadLaunchOrder(index) {
  const offset = index % broadEngines.length;
  const order = broadEngines.slice(offset).concat(broadEngines.slice(0, offset));
  const reference = order.indexOf('playwright');
  const candidate = order.indexOf('flashwright');
  if ((reference < candidate) !== (index % 2 === 0)) [order[reference], order[candidate]] = [order[candidate], order[reference]];
  return order;
}

function positive(value, label) {
  assert.ok(Number.isFinite(value) && value > 0, `${label} must be a positive finite observation`);
  return value;
}

/** Recheck original reports instead of trusting admission booleans or a producer's summary. */
export function normalizeBroadLaunch({ engine, launchIndex, report, receipt, resources, admission, configuration, contenders, policies, browserPath }) {
  assert.ok(broadEngines.includes(engine));
  assert.ok(Number.isInteger(launchIndex) && launchIndex >= 0 && launchIndex < configuration.independentLaunches);
  assert.equal(resources.schemaVersion, 2);
  assert.ok(Number.isFinite(resources.observedCpuSeconds) && resources.observedCpuSeconds >= 0);
  positive(resources.maximumSampledConcurrentRssBytes, 'sampled memory');
  positive(report.completeMilliseconds, 'complete run');
  const common = {
    engine, launchIndex, processWallMilliseconds: positive(resources.elapsedSeconds, 'watchdog child time') * 1000,
    completeMilliseconds: report.completeMilliseconds,
    cpuSeconds: resources.observedCpuSeconds, maximumConcurrentRssBytes: resources.maximumSampledConcurrentRssBytes,
    unexpectedFailures: 0,
  };
  if (engine === 'flashwright' || engine === 'playwright') {
    assert.equal(report.engine, engine);
    assert.equal(report.launchIndex, launchIndex);
    assert.deepEqual(report.resources, resources);
    assert.deepEqual(report.contractFailures, []);
    verifyLaunch(report, configuration, policies.chromium, browserPath);
    for (const workload of report.workloads.filter(workload => workload.name !== 'setup')) {
      assert.deepEqual(workload.observations.viewport, configuration.viewport);
      assert.equal(workload.observations.focused, true);
      assert.equal(workload.observations.visibilityState, 'visible');
    }
  } else {
    assert.equal(receipt.inputsUnchanged, true);
    assert.equal(receipt.exit.code, 0);
    if (report.sampling) {
      assert.ok(['puppeteer', 'webdriverio'].includes(engine));
      assert.equal(report.sampling.launchIndex, launchIndex);
      assert.ok(admission, 'Library sampling requires separate current-source functional admission');
      const verifyAdmission = engine === 'puppeteer' ? verifyPuppeteerAdmission : verifyWebdriverAdmission;
      const admissionDecision = verifyAdmission(admission.report, admission.resources, configuration, contenders, policies.chromium, policies.webdriverio);
      assert.equal(admission.receipt.inputsUnchanged, true);
      assert.equal(admission.receipt.exit.code, 0);
      for (const [key, value] of Object.entries(admissionDecision)) assert.deepEqual(admission.receipt[key], value, `Changed separate admission decision: ${key}`);
      for (const key of ['engine', 'package', 'browser', 'driver', 'runtime']) assert.deepEqual(report[key], admission.report[key], `Sampling/admission identity mismatch: ${key}`);
    }
    const decision = engine === 'puppeteer'
      ? (report.sampling ? verifyPuppeteerSample : verifyPuppeteerAdmission)(report, resources, configuration, contenders, policies.chromium)
      : engine === 'webdriverio'
        ? (report.sampling ? verifyWebdriverSample : verifyWebdriverAdmission)(report, resources, configuration, contenders, policies.chromium, policies.webdriverio)
        : verifyCypressOutcomeAdmission(report, resources, configuration, contenders, policies.cypress);
    for (const [key, value] of Object.entries(decision)) assert.deepEqual(receipt[key], value, `Changed admission decision: ${key}`);
  }
  if (engine !== 'cypress') {
    const samples = Object.fromEntries(report.workloads.map(workload => {
      assert.deepEqual(workload.samples.map(sample => sample.iteration), Array.from({ length: configuration.measuredIterations }, (_, index) => index));
      assert.deepEqual(workload.warmupSamples.map(sample => sample.iteration), Array.from({ length: configuration.warmupIterations }, (_, index) => index));
      const allSamples = [...workload.samples, ...workload.warmupSamples];
      for (const sample of allSamples) positive(sample.milliseconds, `${workload.name} operation`);
      assert.ok(Number.isFinite(workload.preparationMilliseconds) && workload.preparationMilliseconds >= 0);
      assert.ok(workload.completeMilliseconds >= workload.preparationMilliseconds + allSamples.reduce((sum, sample) => sum + sample.milliseconds, 0));
      return [workload.name, workload.samples.map(sample => sample.milliseconds)];
    }));
    const semanticDifferences = [...(receipt?.differences ?? [])];
    if (receipt?.launchPolicyEquivalent === false) semanticDifferences.push({ workload: 'all', reason: receipt.launchPolicyDifference });
    return {
      ...common, comparisonClass: 'library-flow', startupMilliseconds: positive(report.launchMilliseconds, 'browser startup'),
      workloads: samples,
      workloadTotals: Object.fromEntries(report.workloads.map(workload => [workload.name, workload.completeMilliseconds])),
      semanticDifferences,
      equivalentReferenceWork: engine === 'flashwright' || engine === 'playwright',
      instrumentation: report.sampling ? (engine === 'webdriverio' ? ['Startup process-command observation'] : [])
        : engine === 'webdriverio' ? ['Verbose ChromeDriver protocol logging', 'Per-iteration report persistence', 'Extra isolation probe']
        : engine === 'puppeteer' ? ['Per-iteration report persistence', 'Extra isolation probe'] : [],
    };
  }
  const workloads = Object.fromEntries(configuration.workloads.map(name => [name, report.observations
    .filter(observation => observation.title.startsWith(`${name}/sample/`)).map(observation => positive(observation.milliseconds, `${name} operation`))]));
  return {
    ...common, comparisonClass: 'runner-outcome', startupMilliseconds: null,
    workloads, workloadTotals: null, expectedFailures: report.result.totalFailed,
    semanticDifferences: receipt.differences, equivalentReferenceWork: false,
    instrumentation: ['Per-test observation tasks; browser-clock operation interval includes afterEach queueing'],
  };
}

export function summarizeBroadMatrix(launches, configuration, contenders) {
  assert.ok(Number.isInteger(configuration.independentLaunches) && configuration.independentLaunches >= 2);
  const competitors = new Map(contenders.competitors.map(competitor => [competitor.id, competitor]));
  const describe = (launchSamples, unit) => {
    const result = summarize(launchSamples, configuration.statistics);
    return { unit, sampleCount: result.sampleCount, independentLaunchCount: result.independentLaunchCount,
      median: result.launchMedianMilliseconds, confidenceInterval: result.launchMedianConfidenceInterval,
      observedMaximum: result.observedMaximumMilliseconds, p95: result.p95Milliseconds, p99: result.p99Milliseconds };
  };
  const rows = broadEngines.map(engine => {
    const records = launches[engine] ?? [];
    assert.equal(records.length, configuration.independentLaunches, `${engine} needs every independent launch`);
    assert.deepEqual(records.map(record => record.launchIndex), Array.from({ length: configuration.independentLaunches }, (_, index) => index), `${engine} has duplicated, missing or reordered launches`);
    assert.ok(records.every(record => record.engine === engine && record.unexpectedFailures === 0));
    assert.ok(records.every(record => record.comparisonClass === records[0].comparisonClass));
    const metrics = (field, unit) => describe(records.map(record => [record[field]]), unit);
    const differences = [...new Set(records.flatMap(record => record.semanticDifferences.map(difference => typeof difference === 'string' ? difference : `${difference.workload}: ${difference.reason}`)))];
    return {
      engine, version: engine === 'flashwright' ? 'development checkout' : competitors.get(engine)?.version,
      selectionRationale: engine === 'flashwright' ? 'Candidate implementation' : competitors.get(engine)?.reason,
      comparisonClass: records[0].comparisonClass,
      equivalentReferenceWork: records.every(record => record.equivalentReferenceWork),
      semanticDifferences: differences, instrumentation: [...new Set(records.flatMap(record => record.instrumentation))],
      startup: records[0].startupMilliseconds === null ? null : metrics('startupMilliseconds', 'milliseconds'),
      complete: metrics('completeMilliseconds', 'milliseconds'), processWall: metrics('processWallMilliseconds', 'milliseconds'),
      cpu: metrics('cpuSeconds', 'seconds'), maximumConcurrentRss: metrics('maximumConcurrentRssBytes', 'bytes'),
      workloads: Object.fromEntries(configuration.workloads.map(name => [name, describe(records.map(record => record.workloads[name]), 'milliseconds')])),
      workloadTotals: records[0].workloadTotals === null ? null : Object.fromEntries(configuration.workloads.map(name => [name, describe(records.map(record => [record.workloadTotals[name]]), 'milliseconds')])),
      expectedFailures: records.reduce((total, record) => total + (record.expectedFailures ?? 0), 0), unexpectedFailures: 0,
    };
  });
  return { schemaVersion: 1, independentLaunches: configuration.independentLaunches, confidenceLevel: configuration.statistics.confidenceLevel,
    performanceLeadershipEstablished: false, scope: 'Repeated engineering observations; instrumented and outcome-only rows are excluded from equivalent-work speed claims.', rows };
}

function estimate(summary, digits = 1, divisor = 1) {
  if (summary === null) return 'Not isolated';
  const [lower, upper] = summary.confidenceInterval;
  return `${(summary.median / divisor).toFixed(digits)} [${(lower / divisor).toFixed(digits)}, ${(upper / divisor).toFixed(digits)}]`;
}

const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');

/** Keep measurements, work classes and incomplete comparison coverage visible together. */
export function renderBroadMatrixTable(summary) {
  const lines = [summary.scope, '',
    '| Engine | Version | Class | Startup ms | Complete ms | Child process wall ms | CPU s | Median launch peak RSS MiB | Maximum sampled RSS MiB | Failures |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const row of summary.rows) {
    const failures = `${row.expectedFailures} expected, ${row.unexpectedFailures} unexpected`;
    lines.push(`| ${row.engine} | ${row.version} | ${row.comparisonClass} | ${estimate(row.startup)} | ${estimate(row.complete)} | ${estimate(row.processWall)} | ${estimate(row.cpu, 2)} | ${estimate(row.maximumConcurrentRss, 1, 1024 ** 2)} | ${(row.maximumConcurrentRss.observedMaximum / 1024 ** 2).toFixed(1)} | ${failures} |`);
  }
  lines.push('', `Cells show medians of ${summary.independentLaunches} independent-launch medians [${summary.confidenceLevel * 100}% launch-clustered intervals]. Complete runs include preparation, warmup, verification and cleanup. Child wall time uses the common watchdog interval and excludes parent dependency verification.`, '',
    '| Engine | Workload | Operation ms | Preparation-inclusive workload ms | Observed operation maximum ms |',
    '| --- | --- | ---: | ---: | ---: |');
  for (const row of summary.rows) for (const [name, metric] of Object.entries(row.workloads)) {
    lines.push(`| ${row.engine} | ${name} | ${estimate(metric)} | ${estimate(row.workloadTotals?.[name] ?? null)} | ${metric.observedMaximum.toFixed(1)} |`);
  }
  lines.push('', '| Engine | Selection rationale | Recorded differences and instrumentation |', '| --- | --- | --- |');
  for (const row of summary.rows) lines.push(`| ${row.engine} | ${cell(row.selectionRationale)} | ${cell([...row.semanticDifferences, ...row.instrumentation].join('; ') || 'None in the measured fixture contract')} |`);
  lines.push('', 'The library-flow rows and Cypress runner-outcome row do not measure the same complete work. Diagnostic admission rows retain the instrumentation listed above. Native Linux, contention and representative matched runner suites remain open. No broad performance ranking follows from this table.');
  return lines.join('\n') + '\n';
}
