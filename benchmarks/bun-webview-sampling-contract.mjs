import assert from 'node:assert/strict';
import { bunWebViewPin, bunWebViewNativeLaunchPolicy, bunWebViewOptions, bunWebViewDraftClassifications, bunWebViewWorkloads } from './bun-webview-workloads.mjs';

const duration = value => assert.ok(Number.isFinite(value) && value >= 0, 'Expected a finite nonnegative duration');

/** Verify native outcomes, not reference equivalence or external resource custody. */
export function verifyBunWebViewSample(report, configuration) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.engine, 'bun-webview');
  assert.equal(report.classification, 'linux-native-chrome-library-observation');
  assert.equal(report.status, 'completed-native-observations');
  assert.deepEqual(report.configuration, configuration);
  assert.deepEqual(configuration.workloads, [...bunWebViewWorkloads]);
  assert.equal(report.runtime.version, bunWebViewPin.version);
  assert.equal(report.runtime.revision, bunWebViewPin.revision);
  assert.equal(report.browser.version, configuration.browserVersion);
  assert.equal(report.browser.distribution, 'chromium-headless-shell');
  for (const identity of [report.runtime, report.browser]) assert.match(identity.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.options, bunWebViewOptions(report.browser.executablePath, configuration.viewport));
  assert.deepEqual(report.nativeLaunchPolicy, bunWebViewNativeLaunchPolicy);
  assert.deepEqual(report.classifications, bunWebViewDraftClassifications());
  for (const key of ['equivalentWorkAdmission', 'resourceAdmission', 'performanceAccepted']) assert.equal(report[key], false);
  assert.equal(report.selectedInputsUnchanged, true);
  assert.deepEqual(report.failures, []);
  const launch = report.sampling.launchIndex;
  assert.ok(Number.isInteger(launch) && launch >= 0 && launch < configuration.independentLaunches);
  assert.deepEqual(report.sampling, { launchIndex: launch, reportPersistence: 'after-completion', isolationProbe: 'separate-admission', protocolLogging: 'off' });
  const offset = launch % configuration.workloads.length;
  assert.deepEqual(report.workloads.map(row => row.name), configuration.workloads.slice(offset).concat(configuration.workloads.slice(0, offset)));
  const iterations = configuration.warmupIterations + configuration.measuredIterations;
  for (const row of report.workloads) {
    assert.deepEqual(row.failures, []);
    for (const [phase, count] of [['warmupSamples', configuration.warmupIterations], ['samples', configuration.measuredIterations]]) {
      assert.equal(row[phase].length, count);
      row[phase].forEach((sample, index) => { assert.equal(sample.iteration, index); duration(sample.milliseconds); });
    }
    for (const key of ['preparationMilliseconds', 'observationMilliseconds', 'closeRequestMilliseconds', 'completeMilliseconds']) duration(row[key]);
    const accounted = row.preparationMilliseconds + row.observationMilliseconds + row.closeRequestMilliseconds
      + [...row.warmupSamples, ...row.samples].reduce((sum, sample) => sum + sample.milliseconds, 0);
    assert.ok(accounted <= row.completeMilliseconds + 0.001, 'Overlapping or invalid workload intervals');
    const observation = row.observations;
    if (row.name === 'setup') {
      assert.deepEqual(observation, { freshViews: iterations, freshContexts: null, isolation: 'unadmitted-shared-default-browser-context' });
      continue;
    }
    assert.deepEqual(observation.viewport, configuration.viewport);
    assert.equal(observation.untrustedClicks, 0);
    assert.equal(observation.untrustedChanges, 0);
    assert.equal(observation.applicationCount, row.name === 'interaction' ? iterations : 0);
    assert.equal(observation.trustedClicks, ['interaction', 'backend'].includes(row.name) ? iterations : 0);
    if (row.name === 'backend') assert.ok(observation.trustedChanges >= iterations);
    else assert.equal(observation.trustedChanges, 0);
    assert.equal(observation.expectedFailures.length, row.name === 'failure' ? iterations : 0);
    for (const error of observation.expectedFailures) {
      assert.equal(error.operation, 'click');
      assert.equal(error.selector, '#missing');
      assert.equal(error.timeout, configuration.expectedFailureTimeoutMilliseconds);
      assert.match(error.message, /timeout waiting for '#missing' to be actionable/);
      assert.equal(typeof error.stack, 'string');
    }
  }
  assert.equal(report.createdViews, iterations + 6);
  assert.equal(report.backend.documents, iterations * 2 + 6);
  assert.equal(report.backend.backendRequests, iterations);
  assert.ok(Number.isInteger(report.backend.otherRequests) && report.backend.otherRequests >= 0);
  duration(report.cleanupRequestMilliseconds);
  duration(report.completeHostMilliseconds);
  assert.ok(report.workloads.reduce((sum, row) => sum + row.completeMilliseconds, report.cleanupRequestMilliseconds) <= report.completeHostMilliseconds + 0.001);
  return { status: 'verified-native-sampling-outcomes', equivalentWorkAdmission: false, resourceAdmission: false, performanceAccepted: false };
}
