import assert from 'node:assert/strict';
import { reportRuntime } from '../tools/javascript-runtime.mjs';
import { runnerSpecifications } from './runner-suite-contract.mjs';
import { comparePaired, summarize } from './statistics.mjs';

const engines = ['playwright', 'flashwright'];
const workloads = ['noop', 'interaction', 'assertion', 'navigation', 'setup', 'backend', 'failure'];
const diagnosticIdentityFields = ['sourceSha256', 'snapshotSha256', 'normalizedSourceFrameSha256', 'callSite'];

function requireHash(value, description) {
  assert.match(value ?? '', /^[a-f0-9]{64}$/, description);
}

function requireManifest(manifest, description) {
  assert.ok(manifest && Object.keys(manifest).length, `${description} is missing`);
  for (const value of Object.values(manifest)) requireHash(value, description);
}

function requirePositive(value, description) {
  assert.ok(Number.isFinite(value) && value > 0, `${description} must be finite and positive`);
}

/** Retain fractional measured duration; ISO end labels have JavaScript's millisecond precision. */
function runnerInterval(report) {
  const startTime = report.runner.stats.startTime;
  assert.ok(typeof startTime === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(startTime),
    'Runner startTime must be an ISO UTC timestamp with milliseconds');
  const startMilliseconds = Date.parse(startTime);
  assert.ok(Number.isFinite(startMilliseconds) && new Date(startMilliseconds).toISOString() === startTime,
    'Runner startTime must describe a valid calendar timestamp');
  const durationMilliseconds = report.runner.stats.duration;
  requirePositive(durationMilliseconds, 'Recorded runner interval duration');
  const endMilliseconds = startMilliseconds + durationMilliseconds;
  assert.ok(Number.isFinite(endMilliseconds) && endMilliseconds <= 8640000000000000, 'Runner interval end must be a finite timestamp');
  return { startTime, endTime: new Date(endMilliseconds).toISOString(), startMilliseconds, endMilliseconds, durationMilliseconds };
}

function expectedTitles(configuration, launchIndex) {
  const offset = launchIndex % configuration.workloads.length;
  const orderedWorkloads = configuration.workloads.slice(offset).concat(configuration.workloads.slice(0, offset));
  return orderedWorkloads.flatMap(workload => [['warmup', configuration.warmupIterations], ['sample', configuration.measuredIterations]]
    .flatMap(([phase, count]) => Array.from({ length: count }, (_, index) => `${workload}/${phase}/${index}`)));
}

/** Ignore only independently owned output paths when matching retained runner policies. */
function commonRunnerConfiguration(configuration) {
  const common = structuredClone(configuration);
  delete common.outputDir;
  for (const reporter of common.reporter ?? []) if (reporter[1]) delete reporter[1].outputFile;
  return common;
}

function identifyRun(run) {
  const { report, inputs } = run;
  assert.ok(inputs, 'Every runner observation requires retained inputs');
  requireManifest(inputs.sources, 'Common source manifest');
  requireManifest(inputs.dependencies, 'Common dependency manifest');
  requireHash(inputs.browser?.sha256, 'Browser executable identity');
  requireHash(inputs.runtime?.sha256, 'Runtime executable identity');
  requireHash(inputs.driverSha256, 'Driver executable identity');
  assert.ok(inputs.runtime.executable && inputs.driverPath, 'Executable paths are required');
  assert.deepEqual(report.browser, inputs.browser, 'Report browser must bind retained inputs');
  assert.equal(report.driverSha256, inputs.driverSha256, 'Report driver must bind retained inputs');
  const runtime = reportRuntime(report);
  assert.ok(runtime.name === 'bun' ? runtime.version === '1.4.2' : ['22.22.0', '24.15.0'].includes(runtime.version),
    'Original diagnostics require a verified runtime identity');
  if (inputs.runtime.name !== undefined) assert.equal(inputs.runtime.name, runtime.name);
  if (inputs.runtime.version !== undefined) assert.equal(inputs.runtime.version, runtime.version);
  assert.ok(inputs.browser.executablePath && inputs.browser.distribution && inputs.browser.versionOutput, 'Complete browser identity is required');
  assert.ok(inputs.runnerConfiguration, 'Retained runner configuration is required');
  return { runtime, runtimeExecutable: inputs.runtime, browser: inputs.browser, driverPath: inputs.driverPath,
    driverSha256: inputs.driverSha256, sources: inputs.sources, dependencies: inputs.dependencies,
    runnerConfiguration: commonRunnerConfiguration(inputs.runnerConfiguration) };
}

function verifyRun(run, engine, launchIndex, configuration) {
  const { report, admission, resources } = run;
  assert.equal(report.engine, engine);
  assert.equal(report.launchIndex, launchIndex);
  assert.equal(report.comparisonClass, 'runner-fixture');
  assert.deepEqual(report.configuration, configuration);
  assert.equal(report.browser.version, configuration.browserVersion);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.runnerExit, { code: 1, signal: null }, 'Preserve real intentional runner failures');
  assert.equal(admission.status, 'passed-runner-outcomes');
  assert.equal(admission.runnerOutcomeAdmissionPassed, true);
  assert.equal(admission.inputsUnchanged, true);
  assert.equal(admission.exit?.code, 0);
  assert.equal(admission.exit?.signal, null);
  assert.equal(admission.unexpectedFailures, 0);
  assert.equal(admission.actualRunnerFailures, 15);
  assert.equal(admission.expectedRunnerFailures, 15);
  assert.equal(admission.failureDiagnostics?.referenceErrorContextCount, 15);
  assert.equal(admission.failureDiagnostics?.observedErrorContextCount, 15);
  assert.equal(admission.workerCount, admission.browserLaunchCount);
  assert.ok(Number.isInteger(admission.workerCount) && admission.workerCount > 0);
  assert.deepEqual(report.runner.errors, []);
  assert.equal(report.runner.config.workers, configuration.workers);
  assert.equal(report.runner.config.fullyParallel, false);
  assert.equal(report.runner.config.maxFailures, 0);
  assert.equal(report.runner.config.projects.length, 1);
  assert.equal(report.runner.config.projects[0].retries, 0);
  assert.equal(report.runner.config.projects[0].repeatEach, 1);
  assert.equal(report.runner.stats.expected, 90);
  assert.equal(report.runner.stats.unexpected, 15);
  assert.equal(report.runner.stats.flaky, 0);
  assert.equal(report.runner.stats.skipped, 0);
  assert.equal(report.backend.documents, 120);
  assert.equal(report.backend.backendRequests, 15);
  const titles = expectedTitles(configuration, launchIndex);
  assert.deepEqual(admission.tests.map(test => test.title), titles, 'Admission must preserve every original test');
  const specifications = runnerSpecifications(report.runner.suites);
  assert.deepEqual(specifications.map(specification => specification.title), titles, 'Report must preserve every original test');
  const tests = specifications.map((specification, index) => {
    const failure = specification.title.startsWith('failure/');
    assert.equal(specification.tests.length, 1);
    const test = specification.tests[0];
    assert.equal(test.expectedStatus, 'passed');
    assert.equal(test.status, failure ? 'unexpected' : 'expected');
    assert.equal(test.results.length, 1, 'A retry cannot replace an original attempt');
    const result = test.results[0];
    assert.equal(result.retry, 0);
    assert.equal(result.status, failure ? 'failed' : 'passed');
    assert.equal(result.errors.length, failure ? 1 : 0);
    assert.equal(result.attachments.length, failure ? 1 : 0);
    if (failure) {
      assert.equal(result.attachments[0].name, 'error-context');
      assert.equal(result.attachments[0].contentType, 'text/markdown');
    }
    const annotations = result.annotations.filter(annotation => annotation.type === 'runner-suite-observation');
    assert.equal(annotations.length, 1);
    const observation = JSON.parse(annotations[0].description);
    assert.equal(observation.title, specification.title);
    assert.deepEqual(observation.runtime, reportRuntime(report));
    requirePositive(observation.milliseconds, 'Original operation duration');
    requirePositive(result.duration, 'Original test duration');
    const retained = admission.tests[index];
    assert.equal(retained.status, result.status);
    assert.equal(retained.workerIndex, result.workerIndex);
    assert.equal(retained.operationMilliseconds, observation.milliseconds, 'Operation timing must bind original observation');
    assert.equal(retained.testMilliseconds, result.duration, 'Test timing must bind original result');
    return structuredClone(retained);
  });
  const diagnostic = admission.diagnosticAdmission;
  assert.equal(diagnostic?.status, 'passed-controlled-runner-diagnostics');
  assert.equal(diagnostic.controlledDiagnosticAdmissionPassed, true);
  assert.equal(diagnostic.equivalentPredicateEvidence, true);
  assert.equal(diagnostic.casesPerEngine, 15);
  assert.equal(diagnostic.suiteCaseCount, 105);
  assert.equal(diagnostic.successfulCasesWithoutArtifacts, 90);
  assert.equal(diagnostic.expectedFailureTimeoutMilliseconds, configuration.expectedFailureTimeoutMilliseconds);
  const failureTitles = titles.filter(title => title.startsWith('failure/'));
  assert.deepEqual(Object.keys(diagnostic.cases).sort(), [...failureTitles].sort(), 'All original failures need diagnostic admission');
  for (const title of failureTitles) {
    const evidence = diagnostic.cases[title];
    for (const field of [...diagnosticIdentityFields.slice(0, 3), 'documentSha256']) requireHash(evidence[field], `${title} ${field}`);
    assert.ok(Number.isInteger(evidence.callSite?.line) && evidence.callSite.line > 0);
    assert.ok(Number.isInteger(evidence.callSite?.column) && evidence.callSite.column > 0);
    assert.equal(evidence.retainedPredicateObservation, true);
    assert.equal(evidence.errorMeaningVerified, true);
    assert.equal(evidence.captureKind, 'matcher-observation');
    assert.equal(evidence.sourceSha256, run.inputs.sources['benchmarks/runner-suite/workloads.spec.mjs'], 'Diagnostics must bind the common fixture');
  }
  assert.equal(resources.schemaVersion, 2);
  assert.equal(resources.exitCode, 0);
  assert.equal(resources.timedOut, false);
  assert.equal(resources.interrupted, false);
  assert.deepEqual(resources.remainingObservedProcesses, []);
  assert.deepEqual(resources.cleanupSignals, [], 'Watchdog cleanup is not ordinary runner teardown');
  requirePositive(resources.maximumSampledConcurrentRssBytes, 'Sampled concurrent resident memory');
  assert.ok(Number.isFinite(resources.observedCpuSeconds) && resources.observedCpuSeconds >= 0, 'Observed CPU time must be finite and nonnegative');
  requirePositive(report.completeMilliseconds, 'Complete runner duration');
  requirePositive(report.runner.stats.duration, 'Runner-reported duration');
  requirePositive(resources.elapsedSeconds, 'Watchdog duration');
  assert.ok(report.completeMilliseconds >= report.runner.stats.duration);
  assert.ok(resources.elapsedSeconds * 1000 >= report.completeMilliseconds);
  return { tests, diagnosticCases: diagnostic.cases, completeMilliseconds: report.completeMilliseconds,
    runnerMilliseconds: report.runner.stats.duration, peakConcurrentRssBytes: resources.maximumSampledConcurrentRssBytes,
    observedCpuSeconds: resources.observedCpuSeconds, actualRunnerFailures: 15, workerCount: admission.workerCount,
    browserLaunchCount: admission.browserLaunchCount, runnerInterval: runnerInterval(report) };
}

/** Existing statistics use milliseconds internally; expose neutral values with an explicit metric unit. */
function unitSummary(summary, samplesByLaunch) {
  return { sampleCount: summary.sampleCount, independentLaunchCount: summary.independentLaunchCount,
    median: summary.medianMilliseconds, launchMedian: summary.launchMedianMilliseconds,
    launchMedianConfidenceInterval: summary.launchMedianConfidenceInterval, observedMaximum: summary.observedMaximumMilliseconds,
    p95: summary.p95Milliseconds, p99: summary.p99Milliseconds, launchMedians: summary.launchMedians,
    samplesByLaunch: structuredClone(samplesByLaunch) };
}

function compareMetric(referenceSamples, candidateSamples, unit, policy) {
  const positive = [...referenceSamples, ...candidateSamples].flat().every(value => value > 0);
  const comparison = positive ? comparePaired(referenceSamples, candidateSamples, policy) : null;
  const reference = unitSummary(comparison?.reference ?? summarize(referenceSamples, policy), referenceSamples);
  const candidate = unitSummary(comparison?.candidate ?? summarize(candidateSamples, policy), candidateSamples);
  return { unit, reference, candidate, speedupRatios: comparison?.speedupRatios ?? null,
    medianPairedSpeedup: comparison?.medianPairedSpeedup ?? null,
    pairedSpeedupConfidenceInterval: comparison?.pairedSpeedupConfidenceInterval ?? [null, null],
    observedMaximumRatio: reference.observedMaximum > 0 ? candidate.observedMaximum / reference.observedMaximum : null,
    medianRegressionFraction: reference.launchMedian > 0 ? candidate.launchMedian / reference.launchMedian - 1 : null,
    observedMaximumRegressionFraction: reference.observedMaximum > 0 ? candidate.observedMaximum / reference.observedMaximum - 1 : null,
    ...(positive ? {} : { limitation: 'Zero observed CPU time prevents a positive paired ratio comparison; all sampled values remain retained.' }) };
}

/** Admit a complete ordered matrix, retaining every launch and treating confounds as a performance veto. */
export function analyzeRunnerMatrix({ configuration, pairs, environmentalConfounds = [] }) {
  assert.equal(configuration.independentLaunches, 8, 'This matrix requires the configured eight launch pairs');
  assert.deepEqual(configuration.workloads, workloads);
  assert.equal(configuration.warmupIterations, 3);
  assert.equal(configuration.measuredIterations, 12);
  assert.equal(configuration.workers, 1);
  assert.equal(configuration.expectedFailureTimeoutMilliseconds, 250);
  assert.ok(configuration.statistics.minimumSamplesForP95 >= 200);
  assert.ok(configuration.statistics.minimumSamplesForP99 >= 1000);
  assert.ok(Number.isInteger(configuration.statistics.bootstrapReplicates) && configuration.statistics.bootstrapReplicates > 0);
  assert.ok(configuration.statistics.confidenceLevel > 0 && configuration.statistics.confidenceLevel < 1);
  assert.ok(Number.isInteger(configuration.statistics.seed));
  assert.ok(Array.isArray(environmentalConfounds));
  assert.equal(pairs.length, configuration.independentLaunches, 'No launch may be excluded');
  assert.deepEqual(pairs[0].order, engines, 'The declared first pair starts with Playwright');
  const startingOrder = pairs[0].order;
  let commonIdentity;
  let commonDiagnostics;
  const launches = pairs.map((pair, launchIndex) => {
    assert.equal(pair.launchIndex, launchIndex, 'Pairs must preserve collection order');
    assert.deepEqual(pair.order, launchIndex % 2 ? [...startingOrder].reverse() : startingOrder, 'Engine launch order must alternate');
    assert.deepEqual(Object.keys(pair.runs).sort(), [...engines].sort());
    const runs = {};
    for (const engine of engines) {
      const identity = identifyRun(pair.runs[engine]);
      if (commonIdentity) assert.deepEqual(identity, commonIdentity, 'Common source, dependency, runtime, browser, driver or runner policy changed');
      else commonIdentity = identity;
      const run = verifyRun(pair.runs[engine], engine, launchIndex, configuration);
      const identities = Object.fromEntries(Object.entries(run.diagnosticCases).map(([title, evidence]) => [title,
        Object.fromEntries(diagnosticIdentityFields.map(field => [field, evidence[field]]))]));
      if (commonDiagnostics) assert.deepEqual(identities, commonDiagnostics, 'Original diagnostic source, snapshot, frame or call site changed');
      else commonDiagnostics = identities;
      runs[engine] = run;
    }
    return { launchIndex, order: [...pair.order], runs };
  });
  const runnerIntervals = launches.flatMap(launch => launch.order.map(engine => ({ launchIndex: launch.launchIndex,
    engine, ...launch.runs[engine].runnerInterval })));
  for (let index = 1; index < runnerIntervals.length; index++) {
    assert.ok(runnerIntervals[index].startMilliseconds >= runnerIntervals[index - 1].endMilliseconds,
      'Recorded runner intervals must follow the declared collection order without overlap');
  }
  const comparisons = {};
  const compare = (name, unit, select) => {
    comparisons[name] = compareMetric(launches.map(launch => select(launch.runs.playwright)),
      launches.map(launch => select(launch.runs.flashwright)), unit, configuration.statistics);
  };
  for (const name of ['completeMilliseconds', 'runnerMilliseconds']) compare(name, 'milliseconds', run => [run[name]]);
  compare('peakConcurrentRssBytes', 'bytes', run => [run.peakConcurrentRssBytes]);
  compare('observedCpuSeconds', 'seconds', run => [run.observedCpuSeconds]);
  for (const workload of workloads) for (const field of ['operationMilliseconds', 'testMilliseconds']) {
    compare(`${workload}/${field}`, 'milliseconds', run => run.tests.filter(test => test.title.startsWith(`${workload}/sample/`)).map(test => test[field]));
  }
  const threshold = configuration.acceptance;
  for (const field of ['minimumMaterialImprovementFraction', 'maximumMedianRegressionFraction', 'maximumObservedTailRegressionFraction',
    'maximumConcurrentResidentMemoryRegressionFraction']) assert.ok(Number.isFinite(threshold[field]) && threshold[field] >= 0 && threshold[field] < 1);
  assert.equal(threshold.allowedUnexpectedFailures, 0);
  const complete = comparisons.completeMilliseconds;
  const materialCompleteImprovement = complete.medianPairedSpeedup >= 1 / (1 - threshold.minimumMaterialImprovementFraction)
    && complete.pairedSpeedupConfidenceInterval[0] > 1;
  const timings = Object.entries(comparisons).filter(([, comparison]) => comparison.unit === 'milliseconds');
  const medianRegressions = timings.filter(([, comparison]) => comparison.medianPairedSpeedup < 1 / (1 + threshold.maximumMedianRegressionFraction)).map(([name]) => name);
  const observedMaximumRegressions = timings.filter(([, comparison]) => comparison.observedMaximumRatio > 1 + threshold.maximumObservedTailRegressionFraction).map(([name]) => name);
  const memoryRegressionFraction = comparisons.peakConcurrentRssBytes.observedMaximumRegressionFraction;
  const medianMemoryRegressionFraction = comparisons.peakConcurrentRssBytes.medianRegressionFraction;
  const memory = comparisons.peakConcurrentRssBytes;
  const resourceAcceptancePassed = memory.candidate.observedMaximum <= memory.reference.observedMaximum * (1 + threshold.maximumConcurrentResidentMemoryRegressionFraction);
  const timingAcceptancePassed = materialCompleteImprovement && !medianRegressions.length && !observedMaximumRegressions.length;
  const performanceAccepted = timingAcceptancePassed && resourceAcceptancePassed && !environmentalConfounds.length;
  return structuredClone({ schemaVersion: 1, comparisonClass: configuration.comparisonClass,
    functionalAdmissionPassed: true, independentPairs: launches.length, testsPerEngine: 840, defaultFailureDocumentsPerEngine: 120,
    configuration, commonIdentity, environmentalConfounds, excludedLaunches: [], launches, comparisons, runnerIntervals,
    actualRunnerIntervalOrderingVerified: true, runnerIntervalOrderingScope: 'Recorded runner intervals, not complete watchdog exclusivity.',
    acceptance: { materialCompleteImprovement, timingAcceptancePassed, resourceAcceptancePassed, medianRegressions,
      observedMaximumRegressions, memoryRegressionFraction, medianMemoryRegressionFraction,
      environmentalAcceptancePassed: !environmentalConfounds.length, performanceAccepted },
    performanceAccepted, scope: 'Controlled native runner fixture with original intentional failures, worker restarts and admitted default diagnostics. No representative application, broad competitor, Linux or performance leadership claim.' });
}

function number(value) {
  return value === null ? 'unavailable' : value.toFixed(3);
}

function markdownText(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function describeConfound(confound) {
  if (typeof confound === 'string') return markdownText(confound);
  const event = confound.event ?? confound.description ?? confound.kind ?? 'Recorded environmental interference';
  const affectedLaunch = confound.affectedLaunch ?? confound.pair;
  const policy = confound.policy;
  return [markdownText(event), affectedLaunch === undefined ? null : `Affected launch: ${markdownText(typeof affectedLaunch === 'object' ? JSON.stringify(affectedLaunch) : affectedLaunch)}.`,
    policy === undefined ? null : `Policy: ${markdownText(policy)}.`].filter(Boolean).join(' ');
}

/** Render descriptive comparisons with sample counts, units, uncertainty and the recorded acceptance limits. */
export function renderRunnerMatrixReport(analysis) {
  const lines = [
    'Controlled native runner matrix.', '',
    `${analysis.independentPairs} ordered independent launch pairs; ${analysis.testsPerEngine} tests and ${analysis.defaultFailureDocumentsPerEngine} default failure documents per engine. Every original failure passed controlled diagnostic admission. No launch or observation was excluded.`, '',
    'The 16 recorded runner start times and measured durations verify the declared alternating order without overlapping runner intervals. This verification covers recorded runner intervals; it does not establish complete watchdog or exclusive host occupancy. Start and end values remain in the machine-readable analysis, including fractional measured end milliseconds.', '',
    `Performance acceptance: ${analysis.performanceAccepted ? 'passed for this controlled fixture' : 'not accepted'}.`, '',
    '| Metric | Unit | Samples per engine | Playwright launch median | Flashwright launch median | Paired ratio (Playwright / Flashwright) | Paired ratio confidence interval | Playwright observed maximum | Flashwright observed maximum |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |',
  ];
  for (const [name, comparison] of Object.entries(analysis.comparisons)) {
    lines.push(`| ${name} | ${comparison.unit} | ${comparison.reference.sampleCount} | ${number(comparison.reference.launchMedian)} | ${number(comparison.candidate.launchMedian)} | ${number(comparison.medianPairedSpeedup)} | ${comparison.pairedSpeedupConfidenceInterval.map(number).join(' to ')} | ${number(comparison.reference.observedMaximum)} | ${number(comparison.candidate.observedMaximum)} |`);
  }
  const thresholds = analysis.configuration.acceptance;
  lines.push('', `Acceptance requires at least ${thresholds.minimumMaterialImprovementFraction * 100}% complete-time reduction and a paired ratio confidence interval excluding parity; timing median regression must stay within ${thresholds.maximumMedianRegressionFraction * 100}% and observed-maximum regression within ${thresholds.maximumObservedTailRegressionFraction * 100}%; largest observed sampled concurrent resident memory growth across all launches must stay within ${thresholds.maximumConcurrentResidentMemoryRegressionFraction * 100}%.`, '',
    `Timing median regressions: ${analysis.acceptance.medianRegressions.join(', ') || 'none'}. Observed-maximum regressions: ${analysis.acceptance.observedMaximumRegressions.join(', ') || 'none'}. Largest observed sampled resident memory change: ${number(analysis.acceptance.memoryRegressionFraction * 100)}%; median sampled peak change: ${number(analysis.acceptance.medianMemoryRegressionFraction * 100)}%.`, '',
    'Complete time includes cold preparation, successful tests, all warmups, real failures, diagnostic capture and teardown. Workload rows use only measured samples; each has 96 correlated observations across eight independent launches. Warmups and all original values remain in the machine-readable analysis. Confidence intervals resample paired launch medians, not individual tests. Observed maxima are descriptive observations; 96 observations do not support p95 or p99 claims.', '',
    analysis.configuration.resourceCoverage, '',
    'Sampled concurrent resident memory is bytes; observed CPU is seconds across the observed process tree. Short-lived processes between samples may be missed. Zero observed CPU values retain descriptive statistics but have no positive paired ratio.', '',
    'Original predicate, common source, accessibility snapshot, normalized source frame and call site admission is scoped to the controlled fixture. Error wording and Markdown bytes may differ. This evidence does not establish general diagnostic parity.', '');
  if (analysis.environmentalConfounds.length) {
    lines.push('Recorded environmental confounds force descriptive and functional use only; timing acceptance remains blocked:', '');
    for (const confound of analysis.environmentalConfounds) lines.push(`- ${describeConfound(confound)}`);
    lines.push('');
  }
  lines.push(analysis.scope, '');
  return lines.join('\n');
}
