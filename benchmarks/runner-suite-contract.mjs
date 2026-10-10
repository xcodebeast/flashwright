import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { launchArguments } from './paired-contract.mjs';
import { reportRuntime } from '../tools/javascript-runtime.mjs';

export function runnerSpecifications(suites) {
  return suites.flatMap(suite => [...(suite.specs ?? []), ...runnerSpecifications(suite.suites ?? [])]);
}

/** Preserve actual failing tests and worker restarts instead of converting them into passing assertions. */
export function verifyRunnerSuite(report, resources, configuration, policy) {
  assert.ok(['playwright', 'flashwright'].includes(report.engine));
  assert.equal(report.comparisonClass, 'runner-fixture');
  assert.deepEqual(report.configuration, configuration);
  assert.equal(report.browser.version, configuration.browserVersion);
  assert.ok(Number.isInteger(report.launchIndex) && report.launchIndex >= 0 && report.launchIndex < configuration.independentLaunches);
  assert.deepEqual(report.failures, []);
  assert.equal(report.runnerExit.code, 1, 'Intentional failures must remain real runner failures');
  assert.equal(report.runnerExit.signal, null);
  const runner = report.runner;
  assert.deepEqual(runner.errors, []);
  assert.equal(runner.config.workers, 1);
  assert.equal(runner.config.fullyParallel, false);
  assert.equal(runner.config.maxFailures, 0);
  assert.equal(runner.config.projects.length, 1);
  assert.equal(runner.config.projects[0].retries, 0);
  assert.equal(runner.config.projects[0].repeatEach, 1);
  const iterations = configuration.warmupIterations + configuration.measuredIterations;
  const offset = report.launchIndex % configuration.workloads.length;
  const order = configuration.workloads.slice(offset).concat(configuration.workloads.slice(0, offset));
  const titles = order.flatMap(workload => [['warmup', configuration.warmupIterations], ['sample', configuration.measuredIterations]]
    .flatMap(([phase, count]) => Array.from({ length: count }, (_, index) => `${workload}/${phase}/${index}`)));
  const specifications = runnerSpecifications(runner.suites);
  assert.deepEqual(specifications.map(specification => specification.title), titles);
  const results = [];
  const workers = new Set();
  const workerProcesses = new Set();
  const diagnostics = [];
  for (const specification of specifications) {
    const workload = specification.title.split('/')[0];
    const intentionalFailure = workload === 'failure';
    assert.equal(specification.tests.length, 1);
    const test = specification.tests[0];
    assert.equal(test.expectedStatus, 'passed');
    assert.equal(test.status, intentionalFailure ? 'unexpected' : 'expected');
    assert.equal(test.results.length, 1);
    const result = test.results[0];
    assert.equal(result.status, intentionalFailure ? 'failed' : 'passed');
    assert.equal(result.retry, 0);
    assert.equal(result.parallelIndex, 0);
    assert.ok(Number.isInteger(result.workerIndex) && result.workerIndex >= 0);
    workers.add(result.workerIndex);
    assert.ok(Number.isFinite(result.duration) && result.duration > 0);
    if (intentionalFailure) {
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0].message ?? '', /#missing/);
      if (report.engine === 'playwright') assert.equal(result.attachments.filter(attachment => attachment.name === 'error-context' && attachment.contentType === 'text/markdown').length, 1, 'Preserve the reference runner\'s default error-context artifact');
    } else assert.deepEqual(result.errors, []);
    const annotations = result.annotations.filter(annotation => annotation.type === 'runner-suite-observation');
    assert.equal(annotations.length, 1);
    const observation = JSON.parse(annotations[0].description);
    assert.equal(observation.title, specification.title);
    assert.deepEqual(observation.isolation, { localStorage: null, sessionStorage: null, cookies: '' });
    assert.equal(observation.contextReused, false);
    assert.equal(observation.browserVersion, configuration.browserVersion);
    assert.equal(observation.nativeBackendGuardActive, report.engine === 'flashwright');
    assert.deepEqual(observation.runtime, reportRuntime(report));
    assert.ok(resources.processes.some(process => process.process === observation.workerProcess));
    workerProcesses.add(observation.workerProcess);
    assert.equal(observation.trustedClicks, ['interaction', 'backend'].includes(workload) ? 1 : 0);
    assert.equal(observation.untrustedClicks, 0);
    assert.equal(observation.trustedChanges, workload === 'backend' ? 1 : 0);
    assert.equal(observation.untrustedChanges, 0);
    assert.equal(observation.applicationCount, workload === 'interaction' ? 1 : 0);
    assert.deepEqual(observation.viewport, configuration.viewport);
    assert.equal(observation.focused, true);
    assert.equal(observation.visibilityState, 'visible');
    assert.ok(Number.isFinite(observation.milliseconds) && observation.milliseconds > 0);
    diagnostics.push(result.stderr.map(entry => entry.text ?? Buffer.from(entry.buffer, 'base64').toString()).join(''));
    results.push({ title: specification.title, status: result.status, workerIndex: result.workerIndex,
      testMilliseconds: result.duration, operationMilliseconds: observation.milliseconds,
      attachments: result.attachments.map(attachment => ({ name: attachment.name, contentType: attachment.contentType })) });
  }
  assert.equal(workerProcesses.size, workers.size);
  const marker = report.engine === 'flashwright' ? 'flashwright:browser <launching> ' : 'pw:browser <launching> ';
  const directLaunches = stripVTControlCharacters(report.runnerStderr).split('\n').filter(line => line.includes(marker));
  const recordedLaunches = stripVTControlCharacters(diagnostics.join('\n')).split('\n').filter(line => line.includes(marker));
  // The JSON reporter can retain the same stderr that the CLI forwards live.
  // Require both copies to agree; never count one launch twice or drop distinct launches.
  if (directLaunches.length && recordedLaunches.length) {
    const commands = lines => lines.map(line => line.slice(line.indexOf(marker) + marker.length));
    assert.deepEqual(commands(recordedLaunches), commands(directLaunches), 'Runner stderr copies disagree');
  }
  const launches = directLaunches.length ? directLaunches : recordedLaunches;
  assert.equal(launches.length, workers.size, 'Each worker must launch exactly one native browser');
  for (const launch of launches) assert.deepEqual(launchArguments(launch, report.engine, report.browser.executablePath), policy.headless);
  assert.equal(runner.stats.expected, iterations * (configuration.workloads.length - 1));
  assert.equal(runner.stats.unexpected, iterations);
  assert.equal(runner.stats.flaky, 0);
  assert.equal(runner.stats.skipped, 0);
  assert.equal(report.backend.documents, titles.length + iterations);
  assert.equal(report.backend.backendRequests, iterations);
  assert.equal(resources.schemaVersion, 2);
  assert.equal(resources.exitCode, 0);
  assert.equal(resources.timedOut, false);
  assert.equal(resources.interrupted, false);
  assert.deepEqual(resources.remainingObservedProcesses, []);
  assert.deepEqual(resources.cleanupSignals, []);
  assert.ok(Number.isFinite(resources.observedCpuSeconds) && resources.observedCpuSeconds >= 0);
  assert.ok(Number.isFinite(resources.maximumSampledConcurrentRssBytes) && resources.maximumSampledConcurrentRssBytes > 0);
  for (const duration of [report.completeMilliseconds, runner.stats.duration, resources.elapsedSeconds]) assert.ok(Number.isFinite(duration) && duration > 0);
  assert.ok(report.completeMilliseconds >= runner.stats.duration && resources.elapsedSeconds * 1000 >= report.completeMilliseconds);
  const failureSnapshots = results.filter(result => result.title.startsWith('failure/')).flatMap(result => result.attachments)
    .filter(attachment => attachment.name === 'error-context' && attachment.contentType === 'text/markdown').length;
  return { runnerOutcomeAdmissionPassed: true, performanceAccepted: false, actualRunnerFailures: iterations,
    expectedRunnerFailures: iterations, unexpectedFailures: 0, browserLaunchCount: launches.length, workerCount: workers.size, tests: results,
    equivalentReferenceWork: report.engine === 'playwright', nonEquivalentWorkloads: report.engine === 'playwright' ? [] : ['failure'],
    failureDiagnostics: { referenceErrorContextCount: iterations, observedErrorContextCount: failureSnapshots,
      contentParityVerified: report.engine === 'playwright',
      limitation: report.engine === 'playwright' ? 'Reference default error-context artifacts retained.'
        : `Reference emits ${iterations} default error-context snapshots; candidate emits ${failureSnapshots}. Complete failure diagnostics are not equivalent or verified for speed acceptance.` },
    limitation: 'Controlled native runner fixture suite, including real intentional failures and worker restarts. No representative application, broad competitor or performance leadership claim.' };
}

/** A functional inventory keeps missing diagnostic work visible without publishing timing claims. */
export function renderRunnerSuiteAdmission(report, receipt) {
  const diagnosticAdmissionPassed = receipt.diagnosticAdmission?.status === 'passed-controlled-runner-diagnostics';
  const completeWork = diagnosticAdmissionPassed ? 'Controlled fixture admitted, including original diagnostics'
    : receipt.equivalentReferenceWork ? 'Reference baseline' : 'No: failure diagnostics differ or remain unverified';
  return [
    'Functional runner admission only. These are outcome counts, not comparative performance results.', '',
    '| Engine | Tests | Passed | Intentional actual failures | Workers | Browser launches | Error-context snapshots | Equivalent complete reference work |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    `| ${report.engine} | ${receipt.tests.length} | ${report.runner.stats.expected} | ${receipt.actualRunnerFailures} | ${receipt.workerCount} | ${receipt.browserLaunchCount} | ${receipt.failureDiagnostics.observedErrorContextCount} / ${receipt.failureDiagnostics.referenceErrorContextCount} | ${completeWork} |`, '',
    diagnosticAdmissionPassed
      ? 'Every intentional failure retains the original predicate observation, useful assertion diagnostic, exact fixture accessibility tree and complete original source frame. Error wording differs. This supplemental content admission is scoped to this controlled fixture and does not establish general artifact parity or a speed gain.'
      : receipt.failureDiagnostics.limitation,
    '', receipt.limitation, '',
  ].join('\n');
}
