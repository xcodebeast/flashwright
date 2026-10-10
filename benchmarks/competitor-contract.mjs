import assert from 'node:assert/strict';

/** Admit fixture outcomes independently of timings and retain every contract difference. */
export function verifyPuppeteerAdmission(report, resources, baseline, competitors, launchPolicy) {
  assert.equal(report.engine, 'puppeteer');
  assert.equal(report.package.name, 'puppeteer-core');
  assert.equal(report.package.version, competitors.competitors.find(competitor => competitor.id === 'puppeteer').version);
  assert.deepEqual(report.launchArguments, launchPolicy.headless);
  return verifyFixtureAdmission(report, resources, baseline);
}

/** Require the observed native driver policy without claiming reference-policy equivalence. */
export function verifyWebdriverAdmission(report, resources, baseline, competitors, launchPolicy, driverPolicy) {
  assert.equal(report.engine, 'webdriverio');
  assert.equal(report.package.name, 'webdriverio');
  assert.equal(report.package.version, competitors.competitors.find(competitor => competitor.id === 'webdriverio').version);
  assert.equal(report.protocol, 'webdriver-bidi');
  assert.equal(report.driver.version, driverPolicy.driverVersion);
  assert.equal(report.negotiatedDriverVersion.split(' ')[0], driverPolicy.driverVersion);
  assert.deepEqual(report.driverPolicy, driverPolicy);
  const expectedArguments = launchPolicy.headless.filter(argument => !driverPolicy.removedReferenceSwitches.includes(argument)).map(argument => argument.startsWith('--disable-features=') ? argument.replace('=', `=${driverPolicy.additionalDisabledFeatures.join(',')},`) : argument);
  expectedArguments.push(...driverPolicy.additionalDriverArguments);
  assert.deepEqual([...report.launchArguments].sort(), [...new Set(expectedArguments)].sort());
  return { ...verifyFixtureAdmission(report, resources, baseline), launchPolicyEquivalent: false, launchPolicyDifference: driverPolicy.reason };
}

function verifyFixtureAdmission(report, resources, baseline) {
  assert.deepEqual(report.configuration, baseline);
  assert.equal(report.browser.version, baseline.browserVersion);
  assert.equal(report.browserVersion, baseline.browserVersion);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.isolation, { storage: null, cookies: '' });
  assert.equal(resources.schemaVersion, 2);
  assert.ok(Number.isFinite(resources.observedCpuSeconds) && resources.observedCpuSeconds >= 0);
  assert.ok(Number.isFinite(resources.maximumSampledConcurrentRssBytes) && resources.maximumSampledConcurrentRssBytes > 0);
  assert.equal(resources.exitCode, 0);
  assert.equal(resources.timedOut, false);
  assert.equal(resources.interrupted, false);
  assert.deepEqual(resources.remainingObservedProcesses, []);
  assert.deepEqual(resources.cleanupSignals, []);
  assert.equal(report.workloads.length, baseline.workloads.length);
  assert.deepEqual(report.workloads.map(workload => workload.name).sort(), [...baseline.workloads].sort());
  const iterations = baseline.warmupIterations + baseline.measuredIterations;
  const differences = [{ workload: 'failure', reason: 'Native visibility-selector timeout does not establish equivalent Playwright assertion diagnostics or failure work.' }];
  for (const workload of report.workloads) {
    assert.deepEqual(workload.failures, [], workload.name);
    assert.equal(workload.samples.length, baseline.measuredIterations);
    assert.equal(workload.warmupSamples.length, baseline.warmupIterations);
    const samples = [...workload.warmupSamples, ...workload.samples];
    assert.ok(samples.every(sample => Number.isFinite(sample.milliseconds) && sample.milliseconds > 0));
    assert.ok(workload.completeMilliseconds >= workload.preparationMilliseconds + samples.reduce((sum, sample) => sum + sample.milliseconds, 0));
    if (workload.name === 'setup') {
      assert.equal(workload.observations.freshContexts, iterations);
      continue;
    }
    const observations = workload.observations;
    assert.equal(observations.untrustedClicks, 0, workload.name);
    assert.equal(observations.untrustedChanges, 0, workload.name);
    assert.equal(observations.trustedClicks, ['interaction', 'backend'].includes(workload.name) ? iterations : 0, workload.name);
    assert.equal(observations.applicationCount, workload.name === 'interaction' ? iterations : 0, workload.name);
    assert.deepEqual(observations.viewport, baseline.viewport);
    if (workload.name === 'backend') {
      assert.ok(Number.isInteger(observations.trustedChanges) && observations.trustedChanges >= iterations);
      if (observations.trustedChanges !== iterations) differences.push({ workload: workload.name, reason: `Native fill emitted ${observations.trustedChanges} trusted input events; reference fill expects ${iterations}.` });
    } else assert.equal(observations.trustedChanges, 0);
    if (observations.visibilityState !== 'visible' || observations.focused !== true) differences.push({ workload: workload.name, reason: `Document visibility/focus differs from the reference: ${observations.visibilityState}/${observations.focused}.` });
  }
  assert.equal(report.backend.backendRequests, iterations);
  assert.equal(report.backend.documents, iterations * 2 + baseline.workloads.length - 1 + 2);
  return {
    functionalAdmissionPassed: true,
    performanceAccepted: false,
    differences,
    outcomeMatchedWorkloads: baseline.workloads.filter(name => !differences.some(difference => difference.workload === name)),
    limitation: 'Matched fixture outcomes do not establish complete actionability, assertion, runner-suite or performance equivalence. Comparative timing still needs current Flashwright verification and the declared independent-launch/resource gates.',
  };
}
