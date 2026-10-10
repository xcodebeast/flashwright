import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { analyzeRunnerMatrix, renderRunnerMatrixReport } from '../benchmarks/runner-matrix-contract.mjs';

const configuration = JSON.parse(await readFile(new URL('../benchmarks/configurations/runner-suite.json', import.meta.url), 'utf8'));
const hash = character => character.repeat(64);

function fixture() {
  const state = { configuration: structuredClone(configuration), pairs: [], environmentalConfounds: [] };
  for (let launchIndex = 0; launchIndex < 8; launchIndex++) {
    const pair = { launchIndex, order: launchIndex % 2 ? ['flashwright', 'playwright'] : ['playwright', 'flashwright'], runs: {} };
    for (const engine of ['playwright', 'flashwright']) {
      const runtime = { name: 'bun', version: '1.4.2' };
      const browser = { executablePath: '/synthetic/chrome', sha256: hash('a'), version: configuration.browserVersion,
        versionOutput: `Chromium ${configuration.browserVersion}`, distribution: 'full-chromium' };
      const inputs = { sources: { 'benchmarks/runner-suite/workloads.spec.mjs': hash('b'), 'packages/adapter.mjs': hash('c') },
        dependencies: { 'node_modules/test.js': hash('d') }, browser, runtime: { executable: '/synthetic/bun', sha256: hash('e') },
        driverPath: '/synthetic/driver', driverSha256: hash('f'), generatedFiles: { 'project/adapter.mjs': hash(engine === 'playwright' ? '1' : '2') },
        runnerConfiguration: { workers: 1, retries: 0, repeatEach: 1, fullyParallel: false, maxFailures: 0,
          outputDir: `/synthetic/${launchIndex}/${engine}/output`, reporter: [['json', { outputFile: `/synthetic/${launchIndex}/${engine}/report.json` }]],
          use: { headless: true, viewport: configuration.viewport, trace: 'off', video: 'off', screenshot: 'off' } } };
      const scale = engine === 'flashwright' ? 0.8 : 1;
      const tests = [];
      const cases = {};
      const specifications = [];
      const offset = launchIndex % configuration.workloads.length;
      const orderedWorkloads = configuration.workloads.slice(offset).concat(configuration.workloads.slice(0, offset));
      for (const workload of orderedWorkloads) for (const [phase, count] of [['warmup', 3], ['sample', 12]]) {
        for (let iteration = 0; iteration < count; iteration++) {
          const title = `${workload}/${phase}/${iteration}`;
          const failure = workload === 'failure';
          const duration = (100 + launchIndex + iteration) * scale;
          const operationMilliseconds = (50 + launchIndex + iteration) * scale;
          const attachments = failure ? [{ name: 'error-context', contentType: 'text/markdown', path: `/synthetic/${engine}/${title}.md` }] : [];
          tests.push({ title, status: failure ? 'failed' : 'passed', workerIndex: 0, testMilliseconds: duration, operationMilliseconds,
            attachments: attachments.map(({ name, contentType }) => ({ name, contentType })) });
          specifications.push({ title, tests: [{ expectedStatus: 'passed', status: failure ? 'unexpected' : 'expected', results: [{
            retry: 0, status: failure ? 'failed' : 'passed', workerIndex: 0, duration, errors: failure ? [{ message: 'Original missing-element observation' }] : [],
            attachments, annotations: [{ type: 'runner-suite-observation', description: JSON.stringify({ title, runtime, milliseconds: operationMilliseconds }) }],
          }] }] });
          if (failure) cases[title] = { sourceSha256: hash('b'), snapshotSha256: hash('1'), normalizedSourceFrameSha256: hash('2'),
            documentSha256: hash(engine === 'playwright' ? '3' : '4'), callSite: { line: 90, column: 52 },
            retainedPredicateObservation: true, errorMeaningVerified: true, captureKind: 'matcher-observation' };
        }
      }
      const report = { engine, launchIndex, comparisonClass: 'runner-fixture', configuration: state.configuration, runtime, browser,
        driverSha256: inputs.driverSha256, failures: [], runnerExit: { code: 1, signal: null },
        completeMilliseconds: (20000 + launchIndex * 10) * scale, backend: { documents: 120, backendRequests: 15 },
        runner: { errors: [], config: { workers: 1, fullyParallel: false, maxFailures: 0, projects: [{ retries: 0, repeatEach: 1 }] },
          suites: [{ specs: specifications }], stats: { expected: 90, unexpected: 15, flaky: 0, skipped: 0,
            startTime: new Date(Date.UTC(2026, 9, 10, 12) + (launchIndex * 2 + pair.order.indexOf(engine)) * 60000).toISOString(),
            duration: (19000 + launchIndex * 10) * scale } } };
      const admission = { status: 'passed-runner-outcomes', runnerOutcomeAdmissionPassed: true, inputsUnchanged: true,
        exit: { code: 0, signal: null }, unexpectedFailures: 0, actualRunnerFailures: 15, expectedRunnerFailures: 15,
        workerCount: 15, browserLaunchCount: 15, tests, failureDiagnostics: { referenceErrorContextCount: 15, observedErrorContextCount: 15 },
        diagnosticAdmission: { status: 'passed-controlled-runner-diagnostics', controlledDiagnosticAdmissionPassed: true,
          equivalentPredicateEvidence: true, casesPerEngine: 15, suiteCaseCount: 105, successfulCasesWithoutArtifacts: 90,
          expectedFailureTimeoutMilliseconds: 250, cases } };
      const resources = { schemaVersion: 2, exitCode: 0, timedOut: false, interrupted: false, remainingObservedProcesses: [], cleanupSignals: [],
        maximumSampledConcurrentRssBytes: 1000000 + launchIndex, observedCpuSeconds: 2 * scale, elapsedSeconds: 30 };
      pair.runs[engine] = { report, admission, resources, inputs };
    }
    state.pairs.push(pair);
  }
  return state;
}

const candidate = state => state.pairs[0].runs.flashwright;
const diagnostic = state => candidate(state).admission.diagnosticAdmission.cases['failure/sample/0'];

function changeTiming(run, title, field, value) {
  const retained = run.admission.tests.find(test => test.title === title);
  retained[field] = value;
  const result = run.report.runner.suites[0].specs.find(specification => specification.title === title).tests[0].results[0];
  if (field === 'testMilliseconds') result.duration = value;
  else {
    const annotation = result.annotations[0];
    const observation = JSON.parse(annotation.description);
    observation.milliseconds = value;
    annotation.description = JSON.stringify(observation);
  }
}

test('matrix retains every launch and observation with correct units and launch-clustered summaries', () => {
  const state = fixture();
  const original = structuredClone(state);
  const analysis = analyzeRunnerMatrix(state);
  assert.deepEqual(state, original, 'Analysis must not mutate retained input');
  assert.equal(analysis.functionalAdmissionPassed, true);
  assert.equal(analysis.performanceAccepted, true);
  assert.equal(analysis.independentPairs, 8);
  assert.equal(analysis.testsPerEngine, 840);
  assert.equal(analysis.defaultFailureDocumentsPerEngine, 120);
  assert.equal(analysis.actualRunnerIntervalOrderingVerified, true);
  assert.equal(analysis.runnerIntervals.length, 16);
  assert.deepEqual(analysis.runnerIntervals.map(interval => interval.engine), state.pairs.flatMap(pair => pair.order));
  assert.match(analysis.runnerIntervalOrderingScope, /Recorded runner intervals/);
  assert.match(analysis.runnerIntervalOrderingScope, /not complete watchdog exclusivity/);
  for (const interval of analysis.runnerIntervals) {
    assert.equal(interval.endMilliseconds, interval.startMilliseconds + interval.durationMilliseconds);
    assert.equal(interval.endTime, new Date(interval.endMilliseconds).toISOString());
  }
  assert.equal(analysis.launches[0].runs.playwright.tests.length, 105);
  assert.deepEqual(analysis.excludedLaunches, []);
  assert.equal(Object.keys(analysis.comparisons).length, 18);
  assert.equal(analysis.comparisons.peakConcurrentRssBytes.unit, 'bytes');
  assert.equal(analysis.comparisons.observedCpuSeconds.unit, 'seconds');
  assert.equal(analysis.comparisons.completeMilliseconds.unit, 'milliseconds');
  for (const workload of configuration.workloads) for (const field of ['operationMilliseconds', 'testMilliseconds']) {
    const comparison = analysis.comparisons[`${workload}/${field}`];
    assert.equal(comparison.reference.sampleCount, 96);
    assert.equal(comparison.reference.independentLaunchCount, 8);
    assert.equal(comparison.reference.samplesByLaunch.length, 8);
    assert.equal(comparison.reference.launchMedians.length, 8);
    assert.equal(comparison.reference.p95, null);
    assert.equal(comparison.reference.p99, null);
    assert.equal(comparison.medianPairedSpeedup, 1.25);
  }
  analysis.commonIdentity.sources['packages/adapter.mjs'] = 'changed';
  assert.deepEqual(state, original, 'Returned evidence must not share mutable identities with input');
});

test('recorded environmental interference blocks speed acceptance without excluding favorable or slow observations', () => {
  const state = fixture();
  state.environmentalConfounds = [{ kind: 'concurrent-worktree-creation', pair: 1, description: 'Background work overlapped the candidate launch.' }];
  const analysis = analyzeRunnerMatrix(state);
  assert.equal(analysis.acceptance.timingAcceptancePassed, true);
  assert.equal(analysis.acceptance.environmentalAcceptancePassed, false);
  assert.equal(analysis.performanceAccepted, false);
  assert.deepEqual(analysis.environmentalConfounds, state.environmentalConfounds);
  assert.deepEqual(analysis.excludedLaunches, []);
  assert.equal(analysis.launches.length, 8);
  assert.match(renderRunnerMatrixReport(analysis), /descriptive and functional use only/);
});

test('complete-time gate uses a ten-percent reduction, not a ten-percent ratio gain', () => {
  const state = fixture();
  for (const pair of state.pairs) pair.runs.flashwright.report.completeMilliseconds = pair.runs.playwright.report.completeMilliseconds / 1.1;
  const analysis = analyzeRunnerMatrix(state);
  assert.equal(analysis.acceptance.materialCompleteImprovement, false);
  assert.equal(analysis.performanceAccepted, false);
});

test('complete-time confidence interval must exclude parity despite a favorable paired median', () => {
  const state = fixture();
  for (const pair of state.pairs) {
    const run = pair.runs.flashwright;
    const ratio = pair.launchIndex < 5 ? 1.3 : 0.8;
    run.report.completeMilliseconds = pair.runs.playwright.report.completeMilliseconds / ratio;
    run.report.runner.stats.duration = run.report.completeMilliseconds - 100;
  }
  const analysis = analyzeRunnerMatrix(state);
  assert.ok(analysis.comparisons.completeMilliseconds.medianPairedSpeedup > 1 / 0.9);
  assert.ok(analysis.comparisons.completeMilliseconds.pairedSpeedupConfidenceInterval[0] < 1);
  assert.equal(analysis.acceptance.materialCompleteImprovement, false);
});

test('sample-only workload medians reject a material regression while retaining warmup durations', () => {
  const state = fixture();
  for (const pair of state.pairs) {
    for (const test of pair.runs.playwright.admission.tests.filter(test => test.title.startsWith('assertion/sample/'))) {
      changeTiming(pair.runs.flashwright, test.title, 'operationMilliseconds', test.operationMilliseconds * 1.06);
    }
    changeTiming(pair.runs.flashwright, 'assertion/warmup/0', 'operationMilliseconds', 1000000);
  }
  const analysis = analyzeRunnerMatrix(state);
  assert.deepEqual(analysis.acceptance.medianRegressions, ['assertion/operationMilliseconds']);
  assert.ok(!analysis.acceptance.observedMaximumRegressions.includes('assertion/operationMilliseconds'));
  assert.equal(analysis.launches[0].runs.flashwright.tests.find(test => test.title === 'assertion/warmup/0').operationMilliseconds, 1000000);
  assert.equal(analysis.performanceAccepted, false);
});

test('one retained slow observation rejects the observed-maximum timing threshold without changing the median', () => {
  const state = fixture();
  changeTiming(candidate(state), 'navigation/sample/0', 'testMilliseconds', 1000);
  const analysis = analyzeRunnerMatrix(state);
  assert.ok(analysis.acceptance.observedMaximumRegressions.includes('navigation/testMilliseconds'));
  assert.ok(!analysis.acceptance.medianRegressions.includes('navigation/testMilliseconds'));
  assert.equal(analysis.comparisons['navigation/testMilliseconds'].candidate.samplesByLaunch[0][0], 1000);
  assert.equal(analysis.performanceAccepted, false);
});

test('memory gate uses the largest sampled concurrent peak across launches even when median peaks agree', () => {
  const state = fixture();
  candidate(state).resources.maximumSampledConcurrentRssBytes = 1200000;
  const analysis = analyzeRunnerMatrix(state);
  assert.ok(analysis.acceptance.medianMemoryRegressionFraction < 0.00001);
  assert.ok(analysis.acceptance.memoryRegressionFraction > 0.1);
  assert.equal(analysis.acceptance.resourceAcceptancePassed, false);
  assert.equal(analysis.performanceAccepted, false);
});

test('zero observed CPU time remains descriptive without inventing a paired ratio', () => {
  const state = fixture();
  candidate(state).resources.observedCpuSeconds = 0;
  const comparison = analyzeRunnerMatrix(state).comparisons.observedCpuSeconds;
  assert.equal(comparison.candidate.samplesByLaunch[0][0], 0);
  assert.equal(comparison.medianPairedSpeedup, null);
  assert.deepEqual(comparison.pairedSpeedupConfidenceInterval, [null, null]);
});

test('renderer labels resources, maxima, confidence and scope without claiming performance leadership', () => {
  const markdown = renderRunnerMatrixReport(analyzeRunnerMatrix(fixture()));
  assert.match(markdown, /peakConcurrentRssBytes \| bytes/);
  assert.match(markdown, /observedCpuSeconds \| seconds/);
  assert.match(markdown, /96 correlated observations across eight independent launches/);
  assert.match(markdown, /do not support p95 or p99 claims/);
  assert.match(markdown, /largest observed sampled concurrent resident memory growth/);
  assert.match(markdown, /median sampled peak change/);
  assert.doesNotMatch(markdown, /fastest/i);
});

test('renderer summarizes environmental interference without displaying private receipt identifiers', () => {
  const state = fixture();
  state.environmentalConfounds = [{ event: 'A checkout competed for CPU and filesystem resources.', affectedLaunch: 'pair-01-flashwright',
    policy: 'Retain all observations; no performance acceptance.', creationOperation: 'private-operation-identifier',
    fileTimes: [{ file: '/private/worktree', modifiedSeconds: 123 }] }];
  const analysis = analyzeRunnerMatrix(state);
  const markdown = renderRunnerMatrixReport(analysis);
  assert.match(markdown, /A checkout competed/);
  assert.match(markdown, /pair-01-flashwright/);
  assert.match(markdown, /Retain all observations/);
  assert.doesNotMatch(markdown, /private-operation-identifier|private\/worktree|modifiedSeconds/);
  assert.equal(analysis.environmentalConfounds[0].creationOperation, 'private-operation-identifier');
});

test('runner interval ordering retains fractional durations and allows an exactly adjacent runner start', () => {
  const state = fixture();
  const reference = state.pairs[0].runs.playwright.report.runner.stats;
  reference.duration = 19000.25;
  const analysis = analyzeRunnerMatrix(state);
  assert.equal(analysis.runnerIntervals[0].endMilliseconds, Date.parse(reference.startTime) + 19000.25);
  assert.equal(analysis.runnerIntervals[0].durationMilliseconds, 19000.25);
  reference.duration = 19000;
  candidate(state).report.runner.stats.startTime = new Date(Date.parse(reference.startTime) + reference.duration).toISOString();
  assert.equal(analyzeRunnerMatrix(state).actualRunnerIntervalOrderingVerified, true);
});

for (const [name, change] of [
  ['excluded pair', state => state.pairs.pop()],
  ['duplicated pair', state => { state.pairs[1] = state.pairs[0]; }],
  ['nonalternating order', state => { state.pairs[1].order = state.pairs[0].order; }],
  ['unknown engine order', state => { state.pairs[0].order = ['playwright', 'other']; }],
  ['candidate-first initial pair', state => { for (const pair of state.pairs) pair.order.reverse(); }],
  ['recorded same-pair reversal', state => {
    const reference = state.pairs[0].runs.playwright.report.runner.stats;
    const candidate = state.pairs[0].runs.flashwright.report.runner.stats;
    [reference.startTime, candidate.startTime] = [candidate.startTime, reference.startTime];
  }],
  ['recorded inter-pair reversal', state => {
    const previous = state.pairs[0].runs.flashwright.report.runner.stats;
    const next = state.pairs[1].runs.flashwright.report.runner.stats;
    [previous.startTime, next.startTime] = [next.startTime, previous.startTime];
  }],
  ['overlapping recorded runner intervals', state => {
    const reference = state.pairs[0].runs.playwright.report.runner.stats;
    candidate(state).report.runner.stats.startTime = new Date(Date.parse(reference.startTime) + reference.duration - 1).toISOString();
  }],
  ['missing runner start time', state => { delete candidate(state).report.runner.stats.startTime; }],
  ['non-ISO runner start time', state => { candidate(state).report.runner.stats.startTime = 'October 10, 2026'; }],
  ['invalid calendar runner start time', state => { candidate(state).report.runner.stats.startTime = '2026-02-30T12:00:00.000Z'; }],
  ['nonfinite runner interval duration', state => { candidate(state).report.runner.stats.duration = Infinity; }],
  ['wrong report launch index', state => { candidate(state).report.launchIndex = 1; }],
  ['missing retained inputs', state => { delete candidate(state).inputs; }],
  ['changed source identity', state => { candidate(state).inputs.sources['packages/adapter.mjs'] = hash('9'); }],
  ['changed dependency identity', state => { candidate(state).inputs.dependencies['node_modules/test.js'] = hash('9'); }],
  ['changed runtime executable', state => { candidate(state).inputs.runtime.sha256 = hash('9'); }],
  ['changed reported runtime', state => { candidate(state).report.runtime.version = '22.22.0'; candidate(state).report.runtime.name = 'node'; }],
  ['changed browser executable', state => { candidate(state).inputs.browser.sha256 = hash('9'); }],
  ['unbound reported browser', state => { candidate(state).report.browser = { ...candidate(state).report.browser, distribution: 'other' }; }],
  ['changed driver executable', state => { candidate(state).inputs.driverSha256 = hash('9'); candidate(state).report.driverSha256 = hash('9'); }],
  ['unbound reported driver', state => { candidate(state).report.driverSha256 = hash('9'); }],
  ['changed configuration', state => { candidate(state).report.configuration = { ...state.configuration, workers: 2 }; }],
  ['changed runner policy', state => { candidate(state).inputs.runnerConfiguration.use.headless = false; }],
  ['changed inputs during collection', state => { candidate(state).admission.inputsUnchanged = false; }],
  ['suppressed native failure exit', state => { candidate(state).report.runnerExit.code = 0; }],
  ['wrong failure count', state => { candidate(state).admission.actualRunnerFailures = 14; }],
  ['missing original diagnostic case', state => { delete candidate(state).admission.diagnosticAdmission.cases['failure/sample/0']; }],
  ['missing source-frame identity', state => { delete diagnostic(state).normalizedSourceFrameSha256; }],
  ['changed source-frame identity', state => { diagnostic(state).normalizedSourceFrameSha256 = hash('9'); }],
  ['changed fixture snapshot', state => { diagnostic(state).snapshotSha256 = hash('9'); }],
  ['changed original call site', state => { diagnostic(state).callSite.column++; }],
  ['later fallback diagnostic', state => { diagnostic(state).captureKind = 'page-snapshot-fallback'; }],
  ['missing original predicate', state => { diagnostic(state).retainedPredicateObservation = false; }],
  ['missing test', state => { candidate(state).admission.tests.pop(); }],
  ['forged measured timing', state => { candidate(state).admission.tests[0].operationMilliseconds++; }],
  ['nonfinite complete duration', state => { candidate(state).report.completeMilliseconds = Infinity; }],
  ['unobserved cleanup', state => { candidate(state).resources.cleanupSignals.push({ process: 1234, signal: 'SIGTERM' }); }],
  ['remaining browser process', state => { candidate(state).resources.remainingObservedProcesses.push(1234); }],
  ['watchdog interruption', state => { candidate(state).resources.interrupted = true; }],
  ['negative observed CPU', state => { candidate(state).resources.observedCpuSeconds = -1; }],
  ['unsupported tail sample policy', state => { state.configuration.statistics.minimumSamplesForP95 = 96; }],
]) test(`matrix rejects ${name}`, () => {
  const state = fixture();
  change(state);
  assert.throws(() => analyzeRunnerMatrix(state));
});
