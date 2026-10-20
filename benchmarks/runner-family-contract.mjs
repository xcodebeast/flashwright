import assert from 'node:assert/strict';
import { runnerSpecifications } from './runner-suite-contract.mjs';

export const runnerFamilies = Object.freeze(['interaction', 'assertion', 'navigation', 'setup', 'backend', 'failure']);

export function runnerFamilyTitles(family) {
  assert(runnerFamilies.includes(family), 'Unknown controlled family');
  return [['warmup', 3], ['sample', 12]].flatMap(([phase, count]) =>
    Array.from({ length: count }, (_, index) => `${family}/${phase}/${index}`));
}

/** Original reporter outcomes, not callback execution or resource attestation. */
export function verifyRunnerFamilyOutcomes({ family, engine, workers, configuration, runner, owner, runtime }) {
  const titles = runnerFamilyTitles(family);
  assert(['playwright', 'flashwright'].includes(engine));
  assert([1, 4].includes(workers));
  assert.deepEqual(configuration.workloads, [family]);
  assert.equal(configuration.workers, workers);
  assert.equal(configuration.warmupIterations, 3);
  assert.equal(configuration.measuredIterations, 12);
  assert.deepEqual(runtime, { name: 'bun', version: '1.4.2' });
  assert.deepEqual(owner.failures, []);
  assert.equal(owner.status, 'completed-owner');
  assert.equal(owner.family, family);
  assert.equal(owner.engine, engine);
  assert.equal(owner.workers, workers);
  assert.deepEqual(owner.runnerExit, { code: family === 'failure' ? 1 : 0, signal: null },
    'Intentional failures must remain actual runner failures');
  assert.deepEqual(runner.errors, []);
  assert.equal(runner.config.workers, workers);
  assert.equal(runner.config.fullyParallel, workers === 4);
  assert.equal(runner.config.maxFailures, 0);
  assert.equal(runner.config.forbidOnly, true);
  assert.equal(runner.config.projects.length, 1);
  assert.equal(runner.config.projects[0].retries, 0);
  assert.equal(runner.config.projects[0].repeatEach, 1);
  assert.equal(runner.stats.expected, family === 'failure' ? 0 : 15);
  assert.equal(runner.stats.unexpected, family === 'failure' ? 15 : 0);
  assert.equal(runner.stats.flaky, 0);
  assert.equal(runner.stats.skipped, 0);
  const specifications = runnerSpecifications(runner.suites);
  assert.deepEqual(specifications.map(specification => specification.title), titles);
  const processes = new Map(), workerSlots = new Map(), slots = new Set(), identifiers = new Set(), tests = [];
  for (const specification of specifications) {
    assert.equal(specification.file, 'workloads.spec.mjs');
    assert(typeof specification.id === 'string' && specification.id.length > 0 && !identifiers.has(specification.id),
      'Missing or reused original test identity');
    identifiers.add(specification.id);
    assert.equal(specification.tests.length, 1);
    const test = specification.tests[0];
    assert.equal(test.expectedStatus, 'passed');
    assert.equal(test.status, family === 'failure' ? 'unexpected' : 'expected');
    assert.equal(test.results.length, 1);
    const result = test.results[0];
    assert.equal(result.status, family === 'failure' ? 'failed' : 'passed');
    assert.equal(result.retry, 0);
    assert(Number.isFinite(result.duration) && result.duration >= 0);
    assert(Number.isSafeInteger(result.workerIndex) && result.workerIndex >= 0);
    assert(Number.isSafeInteger(result.parallelIndex) && result.parallelIndex >= 0 && result.parallelIndex < workers);
    slots.add(result.parallelIndex);
    assert.equal(result.errors.length, family === 'failure' ? 1 : 0);
    if (family === 'failure') assert.match(result.errors[0].message ?? '', /#missing/);
    assert.equal(result.attachments.length, family === 'failure' ? 1 : 0);
    if (family === 'failure') {
      assert.equal(result.attachments[0].name, 'error-context');
      assert.equal(result.attachments[0].contentType, 'text/markdown');
    }
    const annotations = result.annotations.filter(annotation => annotation.type === 'runner-suite-observation');
    assert.equal(annotations.length, 1);
    const observation = JSON.parse(annotations[0].description);
    assert.equal(observation.title, specification.title);
    assert.deepEqual(observation.isolation, { localStorage: null, sessionStorage: null, cookies: '' });
    assert.equal(observation.contextReused, false);
    assert.equal(observation.browserVersion, configuration.browserVersion);
    assert.equal(observation.nativeBackendGuardActive, engine === 'flashwright');
    assert.deepEqual(observation.runtime, runtime);
    assert.equal(observation.trustedClicks, ['interaction', 'backend'].includes(family) ? 1 : 0);
    assert.equal(observation.untrustedClicks, 0);
    assert.equal(observation.trustedChanges, family === 'backend' ? 1 : 0);
    assert.equal(observation.untrustedChanges, 0);
    assert.equal(observation.applicationCount, family === 'interaction' ? 1 : 0);
    assert.deepEqual(observation.viewport, configuration.viewport);
    assert.equal(observation.focused, true);
    assert.equal(observation.visibilityState, 'visible');
    assert(Number.isFinite(observation.milliseconds) && observation.milliseconds > 0);
    assert(Number.isSafeInteger(observation.workerProcess) && observation.workerProcess > 0);
    if (processes.has(result.workerIndex)) assert.equal(processes.get(result.workerIndex), observation.workerProcess,
      'Worker index changed process during the suite');
    if (workerSlots.has(result.workerIndex)) assert.equal(workerSlots.get(result.workerIndex), result.parallelIndex,
      'Worker index changed parallel slot during the suite');
    processes.set(result.workerIndex, observation.workerProcess);
    workerSlots.set(result.workerIndex, result.parallelIndex);
    tests.push({ id: specification.id, title: specification.title, status: result.status,
      workerIndex: result.workerIndex, parallelIndex: result.parallelIndex, process: observation.workerProcess });
  }
  assert.equal(processes.size, family === 'failure' ? 15 : workers, 'Missing original worker or failure replacement');
  assert.equal(new Set(processes.values()).size, processes.size, 'Distinct reported workers reused a PID');
  assert.equal(slots.size, workers);
  assert.equal(owner.backend.documents, family === 'navigation' ? 30 : 15);
  assert.equal(owner.backend.backendRequests, family === 'backend' ? 15 : 0);
  assert(Number.isSafeInteger(owner.backend.otherRequests) && owner.backend.otherRequests >= 0);
  return { status: 'verified-reported-runner-family-outcomes', family, engine, workers, tests,
    originalTests: 15, actualFailures: family === 'failure' ? 15 : 0,
    reportedWorkerProcesses: processes.size, reportedParallelSlots: slots.size,
    otherRequests: owner.backend.otherRequests, diagnosticContentVerified: false,
    callbackDispatchVerified: false, nativeContextOwnershipVerified: false,
    resourceAdmission: false, performanceAccepted: false };
}
