import assert from 'node:assert/strict';
import { join } from 'node:path';
import { applicationTestIdentities } from './application-corpus.mjs';
export { applicationTestIdentities } from './application-corpus.mjs';

export function applicationConfiguration(project, browser) {
  return { testDir: './tests', workers: 1, retries: 0, repeatEach: 1, fullyParallel: false, forbidOnly: true, maxFailures: 0,
    timeout: 30000, expect: { timeout: 5000 }, reporter: [['json', { outputFile: join(project, 'report.json') }]], outputDir: join(project, 'results'),
    use: { headless: true, viewport: { width: 1280, height: 720 }, trace: 'off', video: 'off', screenshot: 'off', launchOptions: { executablePath: browser.executablePath } } };
}

export function applicationResults(report) {
  const tests = [];
  function visit(suite, parents = []) {
    for (const specification of suite.specs ?? []) for (const test of specification.tests) tests.push({ file: specification.file,
      title: [...parents, suite.title, specification.title].filter(Boolean).join(' > '), status: test.status, expectedStatus: test.expectedStatus,
      attempts: test.results.map(result => ({ status: result.status, retry: result.retry, errors: result.errors })) });
    for (const child of suite.suites ?? []) visit(child, [...parents, suite.title].filter(Boolean));
  }
  for (const suite of report.suites) visit(suite);
  return tests;
}

/** A completed failing test is useful gap evidence; a skipped or interrupted corpus is incomplete. */
export function verifyApplicationOutcomes({ run, report, corpus, project, browser, command }) {
  assert.deepEqual(run.command, command);
  assert.deepEqual(run.configuration, applicationConfiguration(project, browser));
  assert.deepEqual(report.errors, []);
  const configuration = report.config;
  assert.equal(configuration.version, corpus.manifest.tests.reference);
  assert.equal(configuration.configFile, join(project, 'runner.config.mjs'));
  assert.equal(configuration.rootDir, join(project, 'tests'));
  assert.equal(configuration.workers, 1);
  assert.equal(configuration.forbidOnly, true);
  assert.equal(configuration.fullyParallel, false);
  assert.equal(configuration.maxFailures, 0);
  assert.equal(configuration.shard, null);
  assert.equal(configuration.globalSetup, null);
  assert.equal(configuration.globalTeardown, null);
  assert.deepEqual(configuration.reporter, run.configuration.reporter);
  assert.equal(configuration.projects.length, 1);
  const actualProject = configuration.projects[0];
  assert.equal(actualProject.testDir, join(project, 'tests'));
  assert.equal(actualProject.outputDir, join(project, 'results'));
  assert.equal(actualProject.retries, 0);
  assert.equal(actualProject.repeatEach, 1);
  assert.equal(actualProject.timeout, 30000);
  const specifications = [];
  function visit(suite) { specifications.push(...(suite.specs ?? [])); for (const child of suite.suites ?? []) visit(child); }
  for (const suite of report.suites) visit(suite);
  const compareIdentity = (left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.title.localeCompare(right.title);
  const expected = applicationTestIdentities(corpus).sort(compareIdentity);
  const actual = specifications.map(({ file, title, line }) => ({ file, title, line })).sort(compareIdentity);
  assert.deepEqual(actual, expected, 'Reported tests differ from pinned upstream declarations');
  let passed = 0;
  for (const specification of specifications) {
    assert.equal(specification.tests.length, 1);
    const test = specification.tests[0];
    assert.equal(test.expectedStatus, 'passed');
    assert.equal(test.results.length, 1);
    const result = test.results[0];
    assert.ok(['passed', 'failed', 'timedOut'].includes(result.status), 'Skipped/interrupted attempts do not execute the complete corpus');
    assert.equal(result.retry, 0);
    assert.equal(result.parallelIndex, 0);
    assert.ok(Number.isInteger(result.workerIndex) && result.workerIndex >= 0);
    assert.ok(Number.isFinite(result.duration) && result.duration >= 0);
    const succeeded = result.status === 'passed';
    assert.equal(specification.ok, succeeded);
    assert.equal(test.status, succeeded ? 'expected' : 'unexpected');
    if (succeeded) { assert.deepEqual(result.errors, []); passed++; }
    else assert.ok(result.errors.length > 0, 'A failed attempt must retain its diagnostics');
  }
  assert.equal(specifications.length, corpus.manifest.expectedTests);
  assert.equal(report.stats.expected, passed);
  assert.equal(report.stats.unexpected, specifications.length - passed);
  assert.equal(report.stats.skipped, 0);
  assert.equal(report.stats.flaky, 0);
  assert.ok(Number.isFinite(report.stats.duration) && report.stats.duration > 0);
  assert.deepEqual(run.exit, { code: passed === specifications.length ? 0 : 1, signal: null });
  const assets = corpus.manifest.files.filter(entry => entry.role === 'asset');
  for (const request of run.requests) {
    assert.equal(request.method, 'GET');
    if (request.path === '/favicon.ico') assert.equal(request.status, 204);
    else { assert.ok(assets.some(asset => asset.requestPath === request.path), 'Undeclared application request'); assert.equal(request.status, 200); }
  }
  const counts = path => run.requests.filter(request => request.path === path).length;
  for (const [path, expected] of Object.entries(corpus.manifest.httpExpectations.alwaysExact)) assert.equal(counts(path), expected, path);
  if (passed === specifications.length) {
    for (const [path, expected] of Object.entries(corpus.manifest.httpExpectations.whenAllPassedExact)) assert.equal(counts(path), expected, path);
    for (const [path, minimum] of Object.entries(corpus.manifest.httpExpectations.whenAllPassedMinimum)) assert.ok(counts(path) >= minimum, path);
  }
  return { stats: report.stats, errors: report.errors, tests: applicationResults(report), completeCorpusExecuted: true, passed: passed === specifications.length };
}

/** Keep the watchdog resource contract separate from reusable application outcomes. */
export function verifyApplicationRun({ run, report, resources, corpus, project, browser, command }) {
  const outcomes = verifyApplicationOutcomes({ run, report, corpus, project, browser, command });
  assert.equal(resources.schemaVersion, 2);
  assert.deepEqual(resources.command, command);
  assert.equal(resources.exitCode, run.exit.code);
  assert.equal(resources.timedOut, false);
  assert.equal(resources.interrupted, false);
  assert.deepEqual(resources.cleanupSignals, [], 'Watchdog intervention prevents clean application admission');
  assert.deepEqual(resources.remainingObservedProcesses, []);
  assert.ok(Number.isFinite(resources.elapsedSeconds) && resources.elapsedSeconds * 1000 >= report.stats.duration);
  assert.ok(Number.isFinite(resources.observedCpuSeconds) && resources.observedCpuSeconds >= 0);
  assert.ok(Number.isFinite(resources.maximumSampledConcurrentRssBytes) && resources.maximumSampledConcurrentRssBytes > 0);
  return outcomes;
}
