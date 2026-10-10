import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyPuppeteerAdmission } from '../benchmarks/competitor-contract.mjs';

function fixture() {
  const baseline = { browserVersion: '148.0.7778.96', warmupIterations: 1, measuredIterations: 1, viewport: { width: 1280, height: 720 }, workloads: ['noop', 'interaction', 'assertion', 'navigation', 'setup', 'backend', 'failure'] };
  const competitors = { competitors: [{ id: 'puppeteer', version: '25.13.0' }] };
  const policy = { headless: ['--headless'] };
  const resources = { schemaVersion: 2, observedCpuSeconds: 1, maximumSampledConcurrentRssBytes: 100, exitCode: 0, timedOut: false, interrupted: false, remainingObservedProcesses: [], cleanupSignals: [] };
  const report = {
    engine: 'puppeteer', package: { name: 'puppeteer-core', version: '25.13.0' }, configuration: baseline, browser: { version: baseline.browserVersion }, browserVersion: baseline.browserVersion, launchArguments: policy.headless, failures: [], isolation: { storage: null, cookies: '' }, backend: { backendRequests: 2, documents: 12 },
    workloads: baseline.workloads.map(name => ({ name, preparationMilliseconds: 1, completeMilliseconds: 10, samples: [{ milliseconds: 1 }], warmupSamples: [{ milliseconds: 1 }], failures: [], observations: name === 'setup' ? { freshContexts: 2 } : { trustedClicks: ['interaction', 'backend'].includes(name) ? 2 : 0, untrustedClicks: 0, trustedChanges: name === 'backend' ? 2 : 0, untrustedChanges: 0, applicationCount: name === 'interaction' ? 2 : 0, viewport: baseline.viewport, visibilityState: 'visible', focused: true } })),
  };
  return { report, resources, baseline, competitors, policy };
}

const verify = state => verifyPuppeteerAdmission(state.report, state.resources, state.baseline, state.competitors, state.policy);

test('functional admission never becomes performance acceptance', () => {
  const result = verify(fixture());
  assert.equal(result.functionalAdmissionPassed, true);
  assert.equal(result.performanceAccepted, false);
  assert.equal(result.outcomeMatchedWorkloads.includes('failure'), false);
});

test('native event-count and document-focus differences remain explicit', () => {
  const state = fixture();
  state.report.workloads.find(workload => workload.name === 'backend').observations.trustedChanges = 18;
  state.report.workloads.find(workload => workload.name === 'noop').observations.focused = false;
  const result = verify(state);
  assert.deepEqual(result.differences.map(difference => difference.workload).sort(), ['backend', 'failure', 'noop']);
  assert.equal(result.outcomeMatchedWorkloads.includes('backend'), false);
});

for (const [name, change] of [
  ['untrusted click', state => { state.report.workloads[1].observations.untrustedClicks = 1; }],
  ['untrusted input', state => { state.report.workloads[5].observations.untrustedChanges = 1; }],
  ['missing native input', state => { state.report.workloads[5].observations.trustedChanges = 0; }],
  ['skipped backend request', state => { state.report.backend.backendRequests--; }],
  ['skipped fresh context', state => { state.report.workloads[4].observations.freshContexts--; }],
  ['storage leak', state => { state.report.isolation.storage = 'first'; }],
  ['cookie leak', state => { state.report.isolation.cookies = 'isolation=first'; }],
  ['missing workload', state => { state.report.workloads.pop(); }],
  ['missing sample', state => { state.report.workloads[0].samples.pop(); }],
  ['failed operation', state => { state.report.workloads[0].failures.push('failed'); }],
  ['changed package', state => { state.report.package.version = 'unverified'; }],
  ['changed browser', state => { state.report.browser.version = 'unverified'; }],
  ['changed launch policy', state => { state.report.launchArguments = []; }],
  ['watchdog termination', state => { state.resources.timedOut = true; }],
  ['leaked process', state => { state.resources.remainingObservedProcesses.push(123); }],
  ['watchdog cleanup', state => { state.resources.cleanupSignals.push({ process: 123, signal: 'SIGTERM' }); }],
  ['invalid elapsed time', state => { state.report.workloads[0].samples[0].milliseconds = NaN; }],
  ['incomplete total', state => { state.report.workloads[0].completeMilliseconds = 1; }],
  ['obsolete CPU accounting', state => { state.resources.schemaVersion = 1; }],
  ['missing CPU observation', state => { delete state.resources.observedCpuSeconds; }],
  ['missing memory observation', state => { delete state.resources.maximumSampledConcurrentRssBytes; }],
]) {
  test(`rejects ${name}`, () => {
    const state = fixture();
    change(state);
    assert.throws(() => verify(state));
  });
}
