import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runnerFamilies, runnerFamilyTitles, verifyRunnerFamilyOutcomes } from '../benchmarks/runner-family-contract.mjs';

function fixture(family = 'interaction', engine = 'flashwright', workers = 1) {
  const configuration = { workloads: [family], workers, warmupIterations: 3, measuredIterations: 12,
    browserVersion: '148.0.7778.96', viewport: { width: 1280, height: 720 } };
  const runtime = { name: 'bun', version: '1.4.2' };
  const failed = family === 'failure';
  const specs = runnerFamilyTitles(family).map((title, index) => {
    const workerIndex = failed ? index : index % workers;
    const observation = { title, milliseconds: 1, isolation: { localStorage: null, sessionStorage: null, cookies: '' },
      contextReused: false, browserVersion: configuration.browserVersion, nativeBackendGuardActive: engine === 'flashwright',
      runtime, workerProcess: 1000 + workerIndex, trustedClicks: ['interaction', 'backend'].includes(family) ? 1 : 0,
      untrustedClicks: 0, trustedChanges: family === 'backend' ? 1 : 0, untrustedChanges: 0,
      applicationCount: family === 'interaction' ? 1 : 0, viewport: configuration.viewport, focused: true, visibilityState: 'visible' };
    return { id: 'original-' + index, title, file: 'workloads.spec.mjs', tests: [{ expectedStatus: 'passed',
      status: failed ? 'unexpected' : 'expected', results: [{ status: failed ? 'failed' : 'passed', retry: 0,
        duration: 1, workerIndex, parallelIndex: index % workers, errors: failed ? [{ message: '#missing was not visible' }] : [],
        annotations: [{ type: 'runner-suite-observation', description: JSON.stringify(observation) }],
        attachments: failed ? [{ name: 'error-context', contentType: 'text/markdown' }] : [] }] }] };
  });
  return { family, engine, workers, configuration, runtime,
    owner: { family, engine, workers, status: 'completed-owner', failures: [], runnerExit: { code: failed ? 1 : 0, signal: null },
      backend: { documents: family === 'navigation' ? 30 : 15, backendRequests: family === 'backend' ? 15 : 0, otherRequests: 0 } },
    runner: { errors: [], config: { workers, fullyParallel: workers === 4, maxFailures: 0, forbidOnly: true,
      projects: [{ retries: 0, repeatEach: 1 }] }, suites: [{ specs }],
      stats: { expected: failed ? 0 : 15, unexpected: failed ? 15 : 0, flaky: 0, skipped: 0 } } };
}
const result = state => state.runner.suites[0].specs[0].tests[0].results[0];
const observe = (state, change) => {
  const entry = result(state).annotations[0], value = JSON.parse(entry.description);
  change(value); entry.description = JSON.stringify(value);
};
test('one reported worker cannot change parallel slots', () => {
  const state = fixture('interaction', 'flashwright', 4);
  state.runner.suites[0].specs[4].tests[0].results[0].parallelIndex = 1;
  assert.throws(() => verifyRunnerFamilyOutcomes(state), /changed parallel slot/);
});
for (const family of runnerFamilies) for (const engine of ['playwright', 'flashwright']) for (const workers of [1, 4]) {
  test(`${family} ${engine} ${workers} preserves original outcomes`, () => {
    const receipt = verifyRunnerFamilyOutcomes(fixture(family, engine, workers));
    assert.equal(receipt.originalTests, 15);
    assert.equal(receipt.actualFailures, family === 'failure' ? 15 : 0);
    assert.equal(receipt.reportedWorkerProcesses, family === 'failure' ? 15 : workers);
    assert.equal(receipt.performanceAccepted, false);
    assert.equal(receipt.callbackDispatchVerified, false);
  });
}
for (const [name, change] of [
  ['missing test', s => s.runner.suites[0].specs.pop()],
  ['duplicate identity', s => s.runner.suites[0].specs[0].id = 'original-1'],
  ['substituted family', s => s.family = 'assertion'],
  ['wrong source', s => s.runner.suites[0].specs[0].file = 'other.spec.mjs'],
  ['changed iterations', s => s.configuration.warmupIterations = 0],
  ['runtime substitution', s => s.runtime = { name: 'node', version: '24.15.0' }],
  ['missing request', s => s.owner.backend.documents--],
  ['owner failure', s => s.owner.failures.push('fixture failed')],
  ['hidden skip', s => result(s).status = 'skipped'],
  ['retry', s => result(s).retry = 1],
  ['unexpected runner error', s => s.runner.errors.push({ message: 'worker died' })],
  ['extra artifact', s => result(s).attachments.push({ name: 'trace' })],
  ['out of bounds worker', s => result(s).parallelIndex = 1],
  ['negative duration', s => result(s).duration = -1],
  ['missing observation', s => result(s).annotations = []],
  ['context reuse', s => observe(s, o => o.contextReused = true)],
  ['storage leak', s => observe(s, o => o.isolation.cookies = 'previous')],
  ['synthetic input', s => observe(s, o => { o.trustedClicks = 0; o.untrustedClicks = 1; })],
  ['wrong backend', s => observe(s, o => o.nativeBackendGuardActive = false)],
  ['unfocused document', s => observe(s, o => o.focused = false)],
  ['changed worker PID', s => observe(s, o => o.workerProcess++)],
]) test('rejects ' + name, () => {
  const state = fixture(); change(state); assert.throws(() => verifyRunnerFamilyOutcomes(state));
});
for (const [name, change] of [
  ['converted failure', s => s.owner.runnerExit.code = 0],
  ['expected failure', s => s.runner.suites[0].specs[0].tests[0].expectedStatus = 'failed'],
  ['missing diagnostic', s => result(s).attachments = []],
  ['other assertion', s => result(s).errors[0].message = 'unrelated failure'],
  ['missing replacement', s => { result(s).workerIndex = 1; observe(s, o => o.workerProcess = 1001); }],
]) test('rejects failure substitution: ' + name, () => {
  const state = fixture('failure'); change(state); assert.throws(() => verifyRunnerFamilyOutcomes(state));
});
