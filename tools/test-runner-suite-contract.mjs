import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderRunnerSuiteAdmission, verifyRunnerSuite } from '../benchmarks/runner-suite-contract.mjs';

function fixture(engine = 'playwright') {
  const configuration = { browserVersion: '148.0.7778.96', independentLaunches: 2, warmupIterations: 1, measuredIterations: 2,
    workloads: ['noop', 'interaction', 'assertion', 'navigation', 'setup', 'backend', 'failure'], viewport: { width: 1280, height: 720 } };
  const runtime = { name: 'node', version: '22.22.0' };
  const policy = { headless: ['--headless', '--user-data-dir=__FLASHWRIGHT_PROFILE__'] };
  const specifications = [];
  let workerIndex = 0;
  const workers = new Set();
  for (const workload of configuration.workloads) for (const [phase, count] of [['warmup', 1], ['sample', 2]]) for (let index = 0; index < count; index++) {
    const title = `${workload}/${phase}/${index}`;
    const failure = workload === 'failure';
    workers.add(workerIndex);
    const observation = { title, milliseconds: 1, isolation: { localStorage: null, sessionStorage: null, cookies: '' }, contextReused: false,
      browserVersion: configuration.browserVersion, nativeBackendGuardActive: engine === 'flashwright', workerProcess: 1000 + workerIndex, runtime,
      trustedClicks: ['interaction', 'backend'].includes(workload) ? 1 : 0, untrustedClicks: 0,
      trustedChanges: workload === 'backend' ? 1 : 0, untrustedChanges: 0, applicationCount: workload === 'interaction' ? 1 : 0,
      viewport: configuration.viewport, focused: true, visibilityState: 'visible' };
    specifications.push({ title, tests: [{ expectedStatus: 'passed', status: failure ? 'unexpected' : 'expected', results: [{
      status: failure ? 'failed' : 'passed', retry: 0, workerIndex, parallelIndex: 0, duration: 10,
      errors: failure ? [{ message: "Expected locator('#missing') to be visible" }] : [],
      annotations: [{ type: 'runner-suite-observation', description: JSON.stringify(observation) }], stderr: [],
      attachments: failure && engine === 'playwright' ? [{ name: 'error-context', contentType: 'text/markdown', body: Buffer.from('Synthetic snapshot').toString('base64') }] : [],
    }] }] });
    if (failure) workerIndex++;
  }
  const browser = { version: configuration.browserVersion, executablePath: '/synthetic/chrome' };
  const launches = [...workers].map(index => engine === 'playwright'
    ? `pw:browser <launching> ${browser.executablePath} --headless --user-data-dir=/synthetic/profile-${index}`
    : `flashwright:browser <launching> ${JSON.stringify({ executable: browser.executablePath, arguments: ['--headless', `--user-data-dir=/synthetic/profile-${index}`] })}`);
  for (const index of workers) specifications.find(specification => specification.tests[0].results[0].workerIndex === index).tests[0].results[0].stderr.push({ text: launches[index] });
  const report = { engine, comparisonClass: 'runner-fixture', launchIndex: 0, configuration, runtime, browser, failures: [],
    runnerExit: { code: 1, signal: null }, runnerStderr: launches.join('\n'), completeMilliseconds: 1100, backend: { documents: 24, backendRequests: 3 },
    runner: { errors: [], config: { workers: 1, fullyParallel: false, maxFailures: 0, projects: [{ retries: 0, repeatEach: 1 }] },
      suites: [{ specs: specifications }], stats: { expected: 18, unexpected: 3, flaky: 0, skipped: 0, duration: 1000 } } };
  const resources = { schemaVersion: 2, exitCode: 0, timedOut: false, interrupted: false, remainingObservedProcesses: [], cleanupSignals: [],
    observedCpuSeconds: 0.5, maximumSampledConcurrentRssBytes: 1024, elapsedSeconds: 2, processes: [...workers].map(index => ({ process: 1000 + index })) };
  return { report, resources, configuration, policy };
}

const verify = state => verifyRunnerSuite(state.report, state.resources, state.configuration, state.policy);
const result = (state, index = 0) => state.report.runner.suites[0].specs[index].tests[0].results[0];
function observation(state, change) {
  const annotation = result(state).annotations[0];
  const value = JSON.parse(annotation.description);
  change(value);
  annotation.description = JSON.stringify(value);
}

for (const engine of ['playwright', 'flashwright']) test(`${engine} runner counts real failures and agrees across duplicated stderr records`, () => {
  const decision = verify(fixture(engine));
  assert.equal(decision.runnerOutcomeAdmissionPassed, true);
  assert.equal(decision.performanceAccepted, false);
  assert.equal(decision.actualRunnerFailures, 3);
  assert.equal(decision.unexpectedFailures, 0);
  assert.equal(decision.workerCount, 3);
  assert.equal(decision.browserLaunchCount, 3);
  assert.equal(decision.equivalentReferenceWork, engine === 'playwright');
  assert.deepEqual(decision.nonEquivalentWorkloads, engine === 'playwright' ? [] : ['failure']);
  assert.equal(decision.failureDiagnostics.observedErrorContextCount, engine === 'playwright' ? 3 : 0);
  assert.match(renderRunnerSuiteAdmission(fixture(engine).report, decision), engine === 'playwright' ? /Reference baseline/ : /No: failure diagnostics differ/);
});

for (const [name, change] of [
  ['suppressed runner failure', state => { state.report.runnerExit.code = 0; }],
  ['skipped failed test', state => { result(state, 20).status = 'skipped'; }],
  ['hidden failure annotation', state => { state.report.runner.suites[0].specs[20].tests[0].expectedStatus = 'failed'; }],
  ['retried test', state => { result(state).retry = 1; }],
  ['duplicate attempt', state => { state.report.runner.suites[0].specs[0].tests[0].results.push(result(state)); }],
  ['missing test', state => { state.report.runner.suites[0].specs.pop(); }],
  ['duplicate title', state => { state.report.runner.suites[0].specs[0].title = state.report.runner.suites[0].specs[1].title; }],
  ['unexpected worker error', state => { state.report.runner.errors.push({ message: 'Worker failed' }); }],
  ['context reuse', state => observation(state, value => { value.contextReused = true; })],
  ['storage leak', state => observation(state, value => { value.isolation.localStorage = 'old'; })],
  ['synthetic click', state => observation(state, value => { value.untrustedClicks = 1; })],
  ['changed viewport', state => observation(state, value => { value.viewport.width = 500; })],
  ['foreign worker process', state => observation(state, value => { value.workerProcess = -1; })],
  ['missing native guard', state => { state.report.engine = 'flashwright'; }],
  ['different runtime', state => observation(state, value => { value.runtime.version = '24'; })],
  ['lost observation', state => { result(state).annotations = []; }],
  ['duplicate observation', state => { result(state).annotations.push(result(state).annotations[0]); }],
  ['changed failure diagnostic', state => { result(state, 20).errors[0].message = 'Unrelated failure'; }],
  ['suppressed reference error-context', state => { result(state, 20).attachments = []; }],
  ['extra browser launch', state => { state.report.runnerStderr += '\n' + state.report.runnerStderr.split('\n')[0]; }],
  ['disagreeing stderr copies', state => { result(state).stderr[0].text += ' --disable-features=Other'; }],
  ['skipped backend request', state => { state.report.backend.backendRequests--; }],
  ['skipped navigation', state => { state.report.backend.documents--; }],
  ['watchdog cleanup', state => { state.resources.cleanupSignals.push({ process: 1000, signal: 'SIGTERM' }); }],
  ['missing child resource time', state => { state.resources.elapsedSeconds = 0; }],
  ['nonfinite complete duration', state => { state.report.completeMilliseconds = Infinity; state.resources.elapsedSeconds = Infinity; }],
]) test(`runner suite rejects ${name}`, () => { const state = fixture(); change(state); assert.throws(() => verify(state)); });

test('runner accepts a single stderr channel without losing the launch count', () => {
  const state = fixture();
  state.report.runnerStderr = '';
  assert.equal(verify(state).browserLaunchCount, 3);
});

test('runner reassembles arbitrary stderr byte chunks before parsing launches', () => {
  const state = fixture('flashwright');
  for (const specification of state.report.runner.suites[0].specs) {
    const result = specification.tests[0].results[0];
    result.stderr = result.stderr.flatMap(entry => [{ buffer: Buffer.from(entry.text.slice(0, 30)).toString('base64') }, { text: entry.text.slice(30) }]);
  }
  state.report.runnerStderr = state.report.runnerStderr.replaceAll('"arguments":', '"arguments":\u001b[1A\u001b[2K');
  assert.equal(verify(state).browserLaunchCount, 3);
});
