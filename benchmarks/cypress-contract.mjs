import assert from 'node:assert/strict';

/** Admit ordinary runner outcomes without relabelling synthetic input or reset storage as native parity. */
export function verifyCypressOutcomeAdmission(report, resources, baseline, competitors, launchPolicy) {
  const version = competitors.competitors.find(contender => contender.id === 'cypress').version;
  assert.equal(report.engine, 'cypress');
  assert.equal(report.comparisonClass, 'runner-outcome');
  assert.equal(report.package.name, 'cypress');
  assert.equal(report.package.version, version);
  assert.equal(report.bundle.version, version);
  assert.deepEqual(report.configuration, baseline);
  assert.equal(report.browser.version, baseline.browserVersion);
  assert.deepEqual(report.failures, []);
  assert.equal(resources.schemaVersion, 2);
  assert.equal(resources.exitCode, 0);
  assert.equal(resources.timedOut, false);
  assert.equal(resources.interrupted, false);
  assert.deepEqual(resources.remainingObservedProcesses, []);
  assert.deepEqual(resources.cleanupSignals, []);
  assert.ok(Number.isFinite(resources.observedCpuSeconds) && resources.observedCpuSeconds >= 0);
  assert.ok(Number.isFinite(resources.maximumSampledConcurrentRssBytes) && resources.maximumSampledConcurrentRssBytes > 0);
  const result = report.result;
  assert.equal(result.cypressVersion, version);
  assert.equal(result.browserVersion, baseline.browserVersion);
  assert.equal(result.browserPath, report.browser.executablePath);
  assert.equal(result.failures, undefined);
  assert.equal(result.message, undefined);
  assert.deepEqual(result.configuration, { video: false, screenshotOnRunFailure: false, retries: 0, testIsolation: true, viewportWidth: baseline.viewport.width, viewportHeight: baseline.viewport.height });
  assert.equal(report.launch.browser.path, report.browser.executablePath);
  assert.equal(report.launch.browser.version, baseline.browserVersion);
  assert.equal(report.launch.browser.family, 'chromium');
  assert.equal(report.launch.browser.isHeadless, true);
  const proposed = report.launch.proposedLaunchOptions;
  const debugging = proposed.args.filter(argument => argument.startsWith('--remote-debugging-port='));
  assert.equal(debugging.length, 1);
  assert.match(debugging[0], /^--remote-debugging-port=[1-9]\d*$/);
  assert.ok(Number(debugging[0].split('=')[1]) <= 65535);
  assert.deepEqual({ ...proposed, args: proposed.args.map(argument => argument === debugging[0] ? '--remote-debugging-port=__PORT__' : argument) }, launchPolicy);
  assert.equal(report.browserProcesses.length, 1);
  const browserProcess = report.browserProcesses[0];
  assert.ok(Number.isInteger(browserProcess.process) && browserProcess.process > 0);
  assert.ok(browserProcess.command.startsWith(report.browser.executablePath + ' '));
  assert.ok(browserProcess.command.includes(debugging[0]));
  assert.ok(browserProcess.command.includes('--user-data-dir='));
  assert.equal(result.runs.length, 1);
  const run = result.runs[0];
  assert.equal(run.error, null);
  assert.deepEqual(run.screenshots, []);
  assert.equal(run.video, null);
  const iterations = baseline.warmupIterations + baseline.measuredIterations;
  const total = iterations * baseline.workloads.length;
  assert.equal(result.totalTests, total);
  assert.equal(result.totalPassed, total - iterations);
  assert.equal(result.totalFailed, iterations);
  assert.equal(result.totalSkipped, 0);
  assert.equal(result.totalPending, 0);
  assert.equal(run.tests.length, total);
  assert.equal(report.observations.length, total);
  const expected = baseline.workloads.flatMap(workload => [['warmup', baseline.warmupIterations], ['sample', baseline.measuredIterations]].flatMap(([phase, count]) => Array.from({ length: count }, (_, iteration) => `${workload}/${phase}/${iteration}`)));
  assert.deepEqual(run.tests.map(test => test.title.at(-1)), expected);
  assert.deepEqual(report.observations.map(observation => observation.title), expected);
  for (let index = 0; index < total; index++) {
    const test = run.tests[index], observation = report.observations[index];
    const [workload, phase, iteration] = expected[index].split('/');
    const state = workload === 'failure' ? 'failed' : 'passed';
    assert.equal(test.state, state, expected[index]);
    assert.deepEqual(test.attempts, [{ state }]);
    assert.ok(Number.isFinite(test.duration) && test.duration >= 0);
    assert.ok(Number.isFinite(observation.milliseconds) && observation.milliseconds > 0);
    if (state === 'failed') assert.ok(test.displayError.includes(`Timed out retrying after ${baseline.expectedFailureTimeoutMilliseconds}ms`) && test.displayError.includes('#missing'));
    else assert.equal(test.displayError, null);
    assert.deepEqual(observation.isolation, { localStorage: null, sessionStorage: null, cookies: '' });
    assert.deepEqual(observation.viewport, baseline.viewport);
    assert.equal(observation.focused, true);
    assert.equal(observation.visibilityState, 'visible');
    assert.equal(observation.trustedClicks, 0);
    assert.equal(observation.trustedChanges, 0);
    assert.equal(observation.untrustedClicks, ['interaction', 'backend'].includes(workload) ? 1 : 0);
    const value = `person-${Number(iteration) + (phase === 'sample' ? baseline.warmupIterations : 0) + 1}`;
    assert.equal(observation.untrustedChanges, workload === 'backend' ? value.length : 0);
    assert.equal(observation.applicationCount, workload === 'interaction' ? 1 : 0);
  }
  assert.equal(report.backend.documents, total + iterations);
  assert.equal(report.backend.backendRequests, iterations);
  assert.ok(Number.isFinite(result.totalDuration) && result.totalDuration > 0);
  assert.ok(report.completeMilliseconds >= result.totalDuration);
  return {
    runnerOutcomeAdmissionPassed: true, equivalentOperationAdmissionPassed: false, performanceAccepted: false,
    expectedFailures: iterations, unexpectedFailures: 0,
    differences: [
      'Default Cypress click/type dispatch untrusted events; this does not pass native-input equivalence.',
      'Ordinary testIsolation clears DOM, cookies, localStorage and sessionStorage per test; this does not establish fresh browser-context isolation.',
      'Every case is an isolated runner test with page preparation. It is not the warmed library-flow layout.',
      'Cypress retains its native proxy, runner and launch policy. Proposed arguments and the owned browser process command are recorded separately.',
      'Missing-element cases are actual failed runner tests with Cypress diagnostics. They are expected failures, not suppressed or relabelled passes.',
    ],
  };
}
