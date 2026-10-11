import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeBackendCorpusReferenceReport, backendCorpusReferenceInventory,
  createBackendCorpusReferenceConfigurationData, renderBackendCorpusReferenceConfiguration } from './backend-corpus-reference.mjs';

const options = { frontendDirectory: '/fixture/frontend', backendURL: 'http://127.0.0.1:32109',
  outputDirectory: '/fixture/run/artifacts', jsonReportPath: '/fixture/run/report.json',
  browserExecutablePath: '/fixture/full-chrome/Chrome', workers: 4 };

/** Synthetic pinned-reporter shape only; never represents real browser or application admission. */
function fixture(parameters = options) {
  const configuration = createBackendCorpusReferenceConfigurationData(parameters);
  let chromiumIndex = 0, identityIndex = 0;
  const suites = backendCorpusReferenceInventory.files.map(file => ({ title: file.path, file: file.path.slice('frontend/'.length),
    specs: file.declarations.map(declaration => {
      const index = file.projectName === 'setup' ? -1 : chromiumIndex++;
      const startMilliseconds = Date.parse('2026-01-01T00:00:00.000Z') + (index + 1) * 10;
      return { id: `fixture-test-${identityIndex++}`, title: declaration.title, file: file.path.slice('frontend/'.length),
        line: declaration.line, column: 1, tests: [{ projectName: file.projectName, projectId: file.projectName,
          expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', retry: 0, duration: 5,
            workerIndex: index < 0 ? 0 : index % parameters.workers + 1, parallelIndex: index < 0 ? 0 : index % parameters.workers,
            startTime: new Date(startMilliseconds).toISOString(), errors: [], stdout: [], stderr: [], attachments: [] }] }] };
    }) }));
  return { config: { rootDir: parameters.frontendDirectory, workers: parameters.workers, metadata: configuration.metadata,
    projects: configuration.projects.map(project => ({ name: project.name, id: project.name,
      testDir: configuration.testDir, outputDir: configuration.outputDir, retries: 0, repeatEach: 1 })) },
  suites, errors: [], stats: { expected: 62, unexpected: 0, skipped: 0, flaky: 0 } };
}

function tests(report) { return report.suites.flatMap(suite => suite.specs.flatMap(spec => spec.tests)); }
function updateStats(report) {
  report.stats = Object.fromEntries(['expected', 'unexpected', 'flaky', 'skipped'].map(status => [status,
    tests(report).filter(test => test.status === status).length]));
}

test('reference config retains original setup and auth policy at both requested worker counts', () => {
  for (const workers of [1, 4]) {
    const configuration = createBackendCorpusReferenceConfigurationData({ ...options, workers });
    assert.equal(configuration.workers, workers);
    assert.equal(configuration.fullyParallel, true);
    assert.equal(configuration.retries, 0);
    assert.equal(configuration.repeatEach, 1);
    assert.equal(configuration.webServer, undefined);
    assert.deepEqual(configuration.projects.map(project => project.name), ['setup', 'chromium']);
    assert.deepEqual(configuration.projects[1].dependencies, ['setup']);
    assert.equal(configuration.projects[1].use.storageState, 'playwright/.auth/user.json');
    assert.deepEqual(configuration.use.viewport, { width: 1280, height: 720 });
    assert.equal(configuration.use.headless, true);
    assert.equal(configuration.use.launchOptions.executablePath, options.browserExecutablePath);
    assert.deepEqual([configuration.use.trace, configuration.use.video, configuration.use.screenshot], ['off', 'off', 'off']);
    assert.equal(configuration.reporter[0][1].outputFile, options.jsonReportPath);
    assert.equal(configuration.outputDir, options.outputDirectory);
  }
});

test('reference config requires explicit endpoints and paths and preserves frontend package resolution', () => {
  for (const mutate of [parameters => { delete parameters.backendURL; }, parameters => { parameters.workers = 2; },
    parameters => { parameters.browserExecutablePath = 'guessed-Chrome'; }, parameters => { parameters.jsonReportPath = 'report.json'; }]) {
    const parameters = { ...options };
    mutate(parameters);
    assert.throws(() => renderBackendCorpusReferenceConfiguration(parameters));
  }
  const quotedFrontend = '/fixture/frontend with "quotes" and\nnewline';
  const source = renderBackendCorpusReferenceConfiguration({ ...options, frontendDirectory: quotedFrontend });
  assert.ok(source.includes(JSON.stringify(`${quotedFrontend}/package.json`)));
  assert.match(source, /process\.cwd\(\)/);
  assert.match(source, /version !== '1\.60\.0'/);
  assert.match(source, /devices\['Desktop Chrome'\]/);
  assert.ok(!source.includes('process.chdir'));
});

test('complete synthetic report retains all62 identities without inferring four-way concurrency', () => {
  const report = fixture(), original = structuredClone(report);
  const analysis = analyzeBackendCorpusReferenceReport(report, options);
  assert.equal(analysis.structureMatchesCorpus, true);
  assert.equal(analysis.allTestsPassed, true);
  assert.equal(analysis.inventory.discovered, 62);
  assert.equal(analysis.expectedSetupCount, 1);
  assert.equal(analysis.expectedChromiumCount, 61);
  assert.equal(analysis.configuredWorkers, 4);
  assert.equal(analysis.observedOverlap.maximumOverlappingResultIntervals, 1);
  assert.strictEqual(analysis.rawReport, report);
  assert.deepEqual(report, original);
});

test('failed authentication and skipped dependents are retained as honest outcomes', () => {
  const report = fixture();
  for (const suite of report.suites) for (const spec of suite.specs) for (const test of spec.tests) {
    if (test.projectName === 'setup') {
      test.status = 'unexpected';
      test.results[0].status = 'failed';
      test.results[0].errors = [{ message: 'Original authentication failure', stack: 'Original source stack' }];
    } else { test.status = 'skipped'; test.results = []; }
  }
  report.errors = [{ message: 'Original report-level failure' }];
  updateStats(report);
  const analysis = analyzeBackendCorpusReferenceReport(report, options);
  assert.equal(analysis.structureMatchesCorpus, true);
  assert.equal(analysis.allTestsPassed, false);
  assert.deepEqual(analysis.outcomeCounts, { expected: 0, unexpected: 1, flaky: 0, skipped: 61 });
  assert.equal(analysis.records.length, 62);
  assert.equal(analysis.records.filter(record => record.actualStatus === 'unexecuted').length, 61);
  assert.strictEqual(analysis.originalErrors, report.errors);
  assert.equal(analysis.records.find(record => record.projectName === 'setup').results[0].errors[0].stack, 'Original source stack');
});

test('failed, timed-out and interrupted records keep original diagnostics and attachments', () => {
  const report = fixture();
  for (const [index, status] of ['failed', 'timedOut', 'interrupted'].entries()) {
    const test = tests(report)[index];
    test.status = 'unexpected';
    Object.assign(test.results[0], { status, errors: [{ message: `Original ${status}`, snippet: 'Unchanged source frame' }],
      stdout: [{ text: 'original stdout' }], stderr: [{ text: 'original stderr' }],
      attachments: [{ name: 'original artifact', path: '/fixture/original-artifact', contentType: 'text/plain' }] });
  }
  updateStats(report);
  const original = structuredClone(report), analysis = analyzeBackendCorpusReferenceReport(report, options);
  assert.equal(analysis.structureMatchesCorpus, true);
  assert.equal(analysis.allTestsPassed, false);
  assert.deepEqual(analysis.records.slice(0, 3).map(record => record.actualStatus), ['failed', 'timedOut', 'interrupted']);
  assert.deepEqual(report, original);
  assert.equal(analysis.records[0].results[0].attachments[0].path, '/fixture/original-artifact');
});

test('missing, duplicated and relabelled declarations remain explicit inventory failures', () => {
  for (const [mutate, diagnostic] of [
    [report => report.suites[0].specs.pop(), 'missing'],
    [report => report.suites[0].specs.push(structuredClone(report.suites[0].specs[0])), 'duplicates'],
    [report => { report.suites[0].specs[0].title = 'Replaced original test title'; }, 'unexpected'],
    [report => { report.suites[0].specs[0].file = '../other-source.ts'; }, 'unexpected'],
    [report => { report.suites[0].specs[0].line += 1; }, 'locationMismatches'],
  ]) {
    const report = fixture();
    mutate(report);
    const analysis = analyzeBackendCorpusReferenceReport(report, options);
    assert.equal(analysis.inventory.complete, false);
    assert.ok(analysis.inventory[diagnostic].length);
    assert.strictEqual(analysis.rawReport, report);
  }
});

test('unexpected retries and mismatched configuration do not erase recorded attempts', () => {
  const report = fixture(), originalTest = tests(report)[0];
  originalTest.results.push({ ...structuredClone(originalTest.results[0]), retry: 1 });
  originalTest.status = 'flaky';
  report.config.workers = 8;
  report.config.projects[0].retries = 2;
  updateStats(report);
  const analysis = analyzeBackendCorpusReferenceReport(report, options);
  assert.equal(analysis.structureMatchesCorpus, false);
  assert.equal(analysis.records[0].results.length, 2);
  assert.ok(analysis.configurationIssues.some(issue => issue.includes('retries')));
  assert.ok(analysis.configurationIssues.some(issue => issue.includes('worker')));
  assert.equal(analysis.outcomeCounts.flaky, 1);
});

test('nested suites and rootDir-relative file names preserve original source identity', () => {
  const report = fixture();
  report.config.rootDir = `${options.frontendDirectory}/tests`;
  for (const suite of report.suites) {
    suite.file = suite.file.slice('tests/'.length);
    for (const spec of suite.specs) spec.file = spec.file.slice('tests/'.length);
    suite.suites = [{ title: 'Original describe group', file: suite.file, specs: suite.specs }];
    suite.specs = [];
  }
  const marker = report.config.metadata.backendCorpusReference;
  report.config.metadata.backendCorpusReference = Object.fromEntries(Object.entries(marker).reverse());
  const analysis = analyzeBackendCorpusReferenceReport(report, options);
  assert.equal(analysis.structureMatchesCorpus, true);
  assert.ok(analysis.records.every(record => record.suitePath.includes('Original describe group')));
  assert.ok(analysis.records.some(record => record.title === 'Log in with valid email and password '));
});

test('reported overlap excludes serial setup and does not establish process coverage', () => {
  const report = fixture(), selected = tests(report).filter(test => test.projectName === 'chromium').slice(0, 4);
  for (const [index, test] of selected.entries()) Object.assign(test.results[0], {
    startTime: '2026-01-01T00:00:00.010Z', duration: 8, workerIndex: index + 1, parallelIndex: index,
  });
  const analysis = analyzeBackendCorpusReferenceReport(report, options);
  assert.equal(analysis.observedOverlap.maximumOverlappingResultIntervals, 4);
  assert.match(analysis.observedOverlap.scope, /do not prove owned worker hosts/);
  assert.equal(analysis.observedOverlap.intervals.length, 61);
});

test('partial malformed reports return retained evidence and structural diagnostics', () => {
  const report = { config: {}, suites: [null, { title: 'Partial suite', specs: [{ title: 'Partial spec', tests: null }] }],
    errors: [{ message: 'Original failed report construction' }], stats: {} };
  const analysis = analyzeBackendCorpusReferenceReport(report, options);
  assert.equal(analysis.structureMatchesCorpus, false);
  assert.equal(analysis.allTestsPassed, false);
  assert.ok(analysis.reportIssues.length);
  assert.strictEqual(analysis.rawReport, report);
  assert.strictEqual(analysis.originalErrors, report.errors);
});

test('malformed projects and report roots retain diagnostics without evaluating accessors', () => {
  for (const entry of [null, 42, 'invalid project', [], {}, { name: null }, { name: { toString: 'not callable' } }]) {
    const report = fixture();
    report.config.projects.push(entry);
    const analysis = analyzeBackendCorpusReferenceReport(report, options);
    assert.equal(analysis.structureMatchesCorpus, false);
    assert.equal(analysis.inventory.complete, true);
    assert.ok(analysis.configurationIssues.includes('Malformed reported project entry'));
    assert.strictEqual(analysis.rawReport, report);
    assert.strictEqual(report.config.projects.at(-1), entry);
  }
  for (const report of [null, 42, 'partial JSON value', []]) {
    const analysis = analyzeBackendCorpusReferenceReport(report, options);
    assert.equal(analysis.structureMatchesCorpus, false);
    assert.strictEqual(analysis.rawReport, report);
    assert.ok(analysis.reportIssues.some(issue => issue.includes('Malformed report root')));
  }
  let accessorCalls = 0;
  const rootWithAccessor = Object.defineProperty({}, 'config', { get() { accessorCalls++; throw new Error('Do not evaluate'); } });
  const rootAnalysis = analyzeBackendCorpusReferenceReport(rootWithAccessor, options);
  assert.strictEqual(rootAnalysis.rawReport, rootWithAccessor);
  assert.equal(rootAnalysis.structureMatchesCorpus, false);
  for (const field of ['projects', 'rootDir', 'metadata']) {
    const report = fixture();
    Object.defineProperty(report.config, field, { get() { accessorCalls++; throw new Error('Do not evaluate'); } });
    const configurationAnalysis = analyzeBackendCorpusReferenceReport(report, options);
    assert.equal(configurationAnalysis.structureMatchesCorpus, false);
    assert.ok(configurationAnalysis.configurationIssues.includes('Malformed report configuration object'));
    assert.strictEqual(configurationAnalysis.rawReport, report);
  }
  assert.equal(accessorCalls, 0);
});
