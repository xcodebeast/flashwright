import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyCypressOutcomeAdmission } from '../benchmarks/cypress-contract.mjs';

function fixture() {
  const baseline = { browserVersion: '148.0.7778.96', warmupIterations: 1, measuredIterations: 1, viewport: { width: 1280, height: 720 }, expectedFailureTimeoutMilliseconds: 25, workloads: ['noop', 'interaction', 'assertion', 'navigation', 'setup', 'backend', 'failure'] };
  const competitors = { competitors: [{ id: 'cypress', version: '16.1.1' }] };
  const policy = { args: ['--headless=new', '--remote-debugging-port=__PORT__'], preferences: {}, extensions: [], env: {} };
  const titles = baseline.workloads.flatMap(workload => [`${workload}/warmup/0`, `${workload}/sample/0`]);
  const tests = titles.map(title => {
    const state = title.startsWith('failure/') ? 'failed' : 'passed';
    return { title: ['suite', title], state, attempts: [{ state }], duration: 2, displayError: state === 'failed' ? 'Timed out retrying after 25ms: #missing' : null };
  });
  const observations = titles.map(title => ({ title, milliseconds: 1, isolation: { localStorage: null, sessionStorage: null, cookies: '' }, viewport: baseline.viewport, focused: true, visibilityState: 'visible', trustedClicks: 0, trustedChanges: 0, untrustedClicks: /^(interaction|backend)\//.test(title) ? 1 : 0, untrustedChanges: title.startsWith('backend/') ? 8 : 0, applicationCount: title.startsWith('interaction/') ? 1 : 0 }));
  const report = {
    engine: 'cypress', comparisonClass: 'runner-outcome', package: { name: 'cypress', version: '16.1.1' }, bundle: { version: '16.1.1' }, configuration: baseline,
    browser: { version: baseline.browserVersion, executablePath: '/fixture/chrome' }, failures: [], completeMilliseconds: 100,
    launch: { browser: { path: '/fixture/chrome', version: baseline.browserVersion, family: 'chromium', isHeadless: true }, proposedLaunchOptions: { ...policy, args: ['--headless=new', '--remote-debugging-port=1234'] } },
    browserProcesses: [{ process: 123, parent: 122, command: '/fixture/chrome --headless=new --remote-debugging-port=1234 --user-data-dir=/fixture/profile' }],
    result: { cypressVersion: '16.1.1', browserVersion: baseline.browserVersion, browserPath: '/fixture/chrome', configuration: { video: false, screenshotOnRunFailure: false, retries: 0, testIsolation: true, viewportWidth: 1280, viewportHeight: 720 }, totalTests: 14, totalPassed: 12, totalFailed: 2, totalSkipped: 0, totalPending: 0, totalDuration: 30, runs: [{ error: null, screenshots: [], video: null, tests }] },
    observations, backend: { documents: 16, backendRequests: 2 },
  };
  const resources = { schemaVersion: 2, exitCode: 0, timedOut: false, interrupted: false, remainingObservedProcesses: [], cleanupSignals: [], observedCpuSeconds: 1, maximumSampledConcurrentRssBytes: 1024 };
  return { report, resources, baseline, competitors, policy };
}
const verify = state => verifyCypressOutcomeAdmission(state.report, state.resources, state.baseline, state.competitors, state.policy);

test('Cypress runner outcomes preserve actual expected failures and never imply native/performance equivalence', () => {
  const result = verify(fixture());
  assert.equal(result.runnerOutcomeAdmissionPassed, true);
  assert.equal(result.equivalentOperationAdmissionPassed, false);
  assert.equal(result.performanceAccepted, false);
  assert.equal(result.expectedFailures, 2);
  assert.equal(result.unexpectedFailures, 0);
  assert.equal(result.differences.length, 5);
});

for (const [name, change] of [
  ['changed package', state => { state.report.package.version = 'changed'; }],
  ['changed bundle', state => { state.report.bundle.version = 'changed'; }],
  ['changed browser', state => { state.report.result.browserVersion = 'changed'; }],
  ['alternate browser path', state => { state.report.result.browserPath = '/other/chrome'; }],
  ['disabled isolation', state => { state.report.result.configuration.testIsolation = false; }],
  ['enabled retries', state => { state.report.result.configuration.retries = 1; }],
  ['changed launch policy', state => { state.report.launch.proposedLaunchOptions.args.push('--extra'); }],
  ['foreign browser process', state => { state.report.browserProcesses[0].command = '/other/chrome --remote-debugging-port=1234 --user-data-dir=x'; }],
  ['unexpected runner error', state => { state.report.result.runs[0].error = 'crashed'; }],
  ['unexpected failure', state => { state.report.result.runs[0].tests[0].state = 'failed'; }],
  ['suppressed expected failure', state => { state.report.result.runs[0].tests.at(-1).state = 'passed'; }],
  ['wrong failure diagnostic', state => { state.report.result.runs[0].tests.at(-1).displayError = 'Browser disconnected'; }],
  ['retried test', state => { state.report.result.runs[0].tests[0].attempts.push({ state: 'passed' }); }],
  ['skipped test', state => { state.report.result.totalSkipped = 1; }],
  ['duplicate test', state => { state.report.result.runs[0].tests[1].title = state.report.result.runs[0].tests[0].title; }],
  ['missing observation', state => { state.report.observations.pop(); }],
  ['leaked cookie', state => { state.report.observations[0].isolation.cookies = 'admission=previous-test'; }],
  ['leaked session storage', state => { state.report.observations[0].isolation.sessionStorage = 'previous-test'; }],
  ['changed event trust', state => { state.report.observations[2].trustedClicks = 1; }],
  ['skipped input', state => { state.report.observations[10].untrustedChanges = 0; }],
  ['skipped request', state => { state.report.backend.backendRequests = 0; }],
  ['skipped document', state => { state.report.backend.documents--; }],
  ['leaked process', state => { state.resources.remainingObservedProcesses.push(123); }],
  ['watchdog timeout', state => { state.resources.timedOut = true; }],
  ['watchdog cleanup', state => { state.resources.cleanupSignals.push({ process: 123 }); }],
  ['missing resource observation', state => { delete state.resources.observedCpuSeconds; }],
  ['invalid duration', state => { state.report.observations[0].milliseconds = NaN; }],
]) test(`Cypress rejects ${name}`, () => { const state = fixture(); change(state); assert.throws(() => verify(state)); });
