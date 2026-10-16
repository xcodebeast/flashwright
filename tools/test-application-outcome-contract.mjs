import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { applicationConfiguration, verifyApplicationOutcomes, verifyApplicationRun } from '../benchmarks/application-suite-contract.mjs';

/** Fabricated reports/corpus only: no browser, live runner or resource capture. */
function syntheticFixture() {
  const project = '/synthetic/application/project';
  const browser = { executablePath: '/synthetic/browser' };
  const command = ['/synthetic/bun', '/synthetic/runner', 'test', '--config', join(project, 'runner.config.mjs')];
  const configuration = applicationConfiguration(project, browser);
  const corpus = {
    manifest: {
      tests: { reference: '1.60.0' }, expectedTests: 2,
      files: [{ path: 'tests/synthetic.spec.ts', role: 'test' },
        ...['/fixture', '/asset.js', '/style.css'].map(requestPath => ({ role: 'asset', requestPath }))],
      httpExpectations: { alwaysExact: { '/fixture': 2 }, whenAllPassedExact: { '/asset.js': 2 }, whenAllPassedMinimum: { '/style.css': 1 } },
    },
    files: new Map([['tests/synthetic.spec.ts', Buffer.from("test('first case', async () => {});\ntest('second case', async () => {});\n")]]),
  };
  const specifications = ['first case', 'second case'].map((title, index) => ({
    file: 'synthetic.spec.ts', title, line: index + 1, ok: true,
    tests: [{ expectedStatus: 'passed', status: 'expected',
      results: [{ status: 'passed', retry: 0, workerIndex: 0, parallelIndex: 0, duration: 1, errors: [] }] }],
  }));
  const report = {
    errors: [], stats: { expected: 2, unexpected: 0, skipped: 0, flaky: 0, duration: 8 },
    config: { version: '1.60.0', configFile: join(project, 'runner.config.mjs'), rootDir: join(project, 'tests'),
      workers: 1, forbidOnly: true, fullyParallel: false, maxFailures: 0, shard: null, globalSetup: null, globalTeardown: null,
      reporter: configuration.reporter,
      projects: [{ testDir: join(project, 'tests'), outputDir: join(project, 'results'), retries: 0, repeatEach: 1, timeout: 30000 }] },
    suites: [{ title: 'synthetic suite', specs: specifications }],
  };
  const run = {
    command: [...command], configuration, exit: { code: 0, signal: null },
    requests: ['/fixture', '/fixture', '/asset.js', '/asset.js', '/style.css', '/favicon.ico'].map(path => ({ method: 'GET', path, status: path === '/favicon.ico' ? 204 : 200 })),
  };
  const resources = { schemaVersion: 2, command: [...command], exitCode: 0, timedOut: false, interrupted: false,
    cleanupSignals: [], remainingObservedProcesses: [], elapsedSeconds: 0.1, observedCpuSeconds: 0.01, maximumSampledConcurrentRssBytes: 1024 };
  return { run, report, corpus, project, browser, command, resources };
}

function failedFixture(status = 'failed') {
  const fixture = syntheticFixture();
  const specification = fixture.report.suites[0].specs[0];
  specification.ok = false;
  specification.tests[0].status = 'unexpected';
  Object.assign(specification.tests[0].results[0], { status, errors: [{ message: 'Synthetic original application failure' }] });
  fixture.report.stats.expected = 1;
  fixture.report.stats.unexpected = 1;
  fixture.run.exit.code = fixture.resources.exitCode = 1;
  return fixture;
}

test('synthetic outcome-only validation needs no resource report and preserves result shape', () => {
  const { resources: _resources, ...fixture } = syntheticFixture();
  assert.deepEqual(verifyApplicationOutcomes(fixture), {
    stats: fixture.report.stats, errors: [], completeCorpusExecuted: true, passed: true,
    tests: ['first case', 'second case'].map(title => ({ file: 'synthetic.spec.ts', title: `synthetic suite > ${title}`,
      status: 'expected', expectedStatus: 'passed', attempts: [{ status: 'passed', retry: 0, errors: [] }] })),
  });
});

test('synthetic legacy wrapper returns the same outcomes after resource checks', () => {
  const fixture = syntheticFixture();
  assert.deepEqual(verifyApplicationRun(fixture), verifyApplicationOutcomes(fixture));
});

for (const status of ['failed', 'timedOut']) test(`synthetic ${status} outcome retains original errors and complete execution`, () => {
  const fixture = failedFixture(status);
  // Success-only optional asset counts are deliberately not applied to a failed corpus.
  fixture.run.requests = fixture.run.requests.filter(request => request.path === '/fixture');
  const result = verifyApplicationOutcomes(fixture);
  assert.equal(result.passed, false);
  assert.equal(result.completeCorpusExecuted, true);
  assert.equal(result.tests[0].attempts[0].status, status);
  assert.deepEqual(result.tests[0].attempts[0].errors, [{ message: 'Synthetic original application failure' }]);
  assert.deepEqual(verifyApplicationRun(fixture), result);
});

const firstSpecification = fixture => fixture.report.suites[0].specs[0];
const firstAttempt = fixture => firstSpecification(fixture).tests[0].results[0];

for (const [name, mutate] of [
  ['omitted declaration', fixture => fixture.report.suites[0].specs.pop()],
  ['duplicated declaration', fixture => { fixture.report.suites[0].specs[1] = structuredClone(firstSpecification(fixture)); }],
  ['duplicated test in declaration', fixture => firstSpecification(fixture).tests.push(structuredClone(firstSpecification(fixture).tests[0]))],
  ['skipped attempt', fixture => { firstAttempt(fixture).status = 'skipped'; }],
  ['interrupted attempt', fixture => { firstAttempt(fixture).status = 'interrupted'; }],
  ['unexpected source file', fixture => { firstSpecification(fixture).file = 'another.spec.ts'; }],
  ['changed declaration line', fixture => { firstSpecification(fixture).line = 100; }],
  ['changed declaration title', fixture => { firstSpecification(fixture).title = 'another case'; }],
  ['retries', fixture => { firstAttempt(fixture).retry = 1; }],
  ['extra attempt', fixture => firstSpecification(fixture).tests[0].results.push(structuredClone(firstAttempt(fixture)))],
  ['another parallel worker slot', fixture => { firstAttempt(fixture).parallelIndex = 1; }],
  ['runner error', fixture => fixture.report.errors.push({ message: 'Synthetic runner error' })],
  ['success with retained error', fixture => firstAttempt(fixture).errors.push({ message: 'Unexpected error' })],
  ['changed runtime command', fixture => { fixture.run.command[0] = '/another/runtime'; }],
  ['changed configured worker count', fixture => { fixture.run.configuration.workers = 4; }],
  ['changed reported worker count', fixture => { fixture.report.config.workers = 4; }],
  ['changed artifact policy', fixture => { fixture.run.configuration.use.trace = 'on'; }],
  ['changed reported runner timeout', fixture => { fixture.report.config.projects[0].timeout = 1000; }],
  ['reported global setup', fixture => { fixture.report.config.globalSetup = '/unexpected/setup'; }],
  ['unknown application request', fixture => fixture.run.requests.push({ method: 'GET', path: '/unknown', status: 200 })],
  ['application POST request', fixture => { fixture.run.requests[0].method = 'POST'; }],
  ['failed asset response', fixture => { fixture.run.requests[2].status = 404; }],
  ['wrong favicon response', fixture => { fixture.run.requests.at(-1).status = 200; }],
  ['missing required document request', fixture => fixture.run.requests.shift()],
  ['missing exact successful asset count', fixture => fixture.run.requests.splice(2, 1)],
  ['missing minimum successful asset count', fixture => { fixture.run.requests = fixture.run.requests.filter(request => request.path !== '/style.css'); }],
  ['wrong runner exit', fixture => { fixture.run.exit.code = 1; }],
]) test(`synthetic outcomes reject ${name}`, () => {
  const fixture = syntheticFixture();
  mutate(fixture);
  assert.throws(() => verifyApplicationOutcomes(fixture));
  assert.throws(() => verifyApplicationRun(fixture));
});

test('synthetic failed attempt without original diagnostics is rejected', () => {
  const fixture = failedFixture();
  firstAttempt(fixture).errors = [];
  assert.throws(() => verifyApplicationOutcomes(fixture), /retain its diagnostics/);
});

for (const [name, mutate] of [
  ['old resource schema', resources => { resources.schemaVersion = 1; }],
  ['changed command', resources => { resources.command = ['/another/runtime']; }],
  ['changed terminal exit', resources => { resources.exitCode = 1; }],
  ['timeout', resources => { resources.timedOut = true; }],
  ['interruption', resources => { resources.interrupted = true; }],
  ['cleanup signals', resources => { resources.cleanupSignals.push({ signal: 15 }); }],
  ['remaining process', resources => { resources.remainingObservedProcesses.push(123); }],
  ['short resource interval', resources => { resources.elapsedSeconds = 0.001; }],
  ['missing resource interval', resources => { delete resources.elapsedSeconds; }],
  ['missing CPU observation', resources => { delete resources.observedCpuSeconds; }],
  ['missing RSS observation', resources => { delete resources.maximumSampledConcurrentRssBytes; }],
  ['zero RSS observation', resources => { resources.maximumSampledConcurrentRssBytes = 0; }],
]) test(`synthetic legacy resource check still rejects ${name}`, () => {
  const fixture = syntheticFixture();
  mutate(fixture.resources);
  assert.equal(verifyApplicationOutcomes(fixture).passed, true);
  assert.throws(() => verifyApplicationRun(fixture));
});
