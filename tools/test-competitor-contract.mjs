import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyPuppeteerAdmission, verifyWebdriverAdmission } from '../benchmarks/competitor-contract.mjs';
import { closeWebdriverContexts } from '../benchmarks/webdriverio-workloads.mjs';

test('WebdriverIO cleanup attempts every context and retains operation and cleanup failures', async () => {
  const calls = [];
  const operation = new Error('operation failed');
  const cleanup = new Error('cleanup failed');
  await assert.rejects(closeWebdriverContexts([
    { close() { calls.push('first'); throw cleanup; } },
    { async close() { calls.push('second'); } },
  ], operation), error => error instanceof AggregateError && error.errors[0] === operation && error.errors[1] === cleanup && error.stack.includes('operation failed') && error.stack.includes('cleanup failed'));
  assert.deepEqual(calls, ['first', 'second']);
});

test('WebdriverIO cleanup preserves the original operation error when removal succeeds', async () => {
  const failure = new Error('operation failed');
  await assert.rejects(closeWebdriverContexts([{ async close() {} }], failure), error => error === failure);
});

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

function webdriverFixture() {
  const state = fixture();
  state.competitors.competitors.push({ id: 'webdriverio', version: '10.0.2' });
  state.driverPolicy = { driverVersion: '148.0.7778.96', removedReferenceSwitches: ['--no-startup-window'], additionalDriverArguments: ['--enable-automation', 'data:,'], additionalDisabledFeatures: ['DriverFeature'], reason: 'Native driver bootstrap differs.' };
  state.policy.headless.push('--no-startup-window', '--disable-features=ReferenceFeature', '--headless');
  Object.assign(state.report, { engine: 'webdriverio', package: { name: 'webdriverio', version: '10.0.2' }, protocol: 'webdriver-bidi', driver: { version: state.driverPolicy.driverVersion }, negotiatedDriverVersion: `${state.driverPolicy.driverVersion} (revision)`, driverPolicy: state.driverPolicy, launchArguments: ['--headless', '--disable-features=DriverFeature,ReferenceFeature', '--enable-automation', 'data:,'] });
  return state;
}

const verifyWebdriver = state => verifyWebdriverAdmission(state.report, state.resources, state.baseline, state.competitors, state.policy, state.driverPolicy);

test('WebdriverIO native launch admission preserves reference-policy differences', () => {
  const result = verifyWebdriver(webdriverFixture());
  assert.equal(result.functionalAdmissionPassed, true);
  assert.equal(result.performanceAccepted, false);
  assert.equal(result.launchPolicyEquivalent, false);
  assert.equal(result.launchPolicyDifference, 'Native driver bootstrap differs.');
});

for (const [name, change] of [
  ['fallback protocol', state => { state.report.protocol = 'webdriver-classic'; }],
  ['driver binary version', state => { state.report.driver.version = 'unverified'; }],
  ['negotiated driver version', state => { state.report.negotiatedDriverVersion = 'unverified'; }],
  ['changed native flags', state => { state.report.launchArguments.push('--disable-web-security'); }],
  ['dropped native flags', state => { state.report.launchArguments.pop(); }],
  ['changed native package', state => { state.report.package.version = 'unverified'; }],
  ['missing native isolation', state => { state.report.isolation = null; }],
  ['native process leak', state => { state.resources.remainingObservedProcesses.push(123); }],
]) test(`WebdriverIO rejects ${name}`, () => { const state = webdriverFixture(); change(state); assert.throws(() => verifyWebdriver(state)); });

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
