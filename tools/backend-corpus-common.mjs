import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const inventory = JSON.parse(await readFile(new URL('../benchmarks/configurations/backend-corpus-inventory.json', import.meta.url), 'utf8'));
export const backendCorpusInventory = Object.freeze({ ...inventory,
  files: Object.freeze(inventory.files.map(file => Object.freeze({ ...file,
    declarations: Object.freeze(file.declarations.map(declaration => Object.freeze(declaration))),
  }))),
});

export function normalizeBackendCorpusOptions(options, description = 'Reference') {
  assert.ok(options && [1, 4].includes(options.workers), `${description} workers must be explicitly 1 or 4`);
  const normalized = { ...options };
  for (const name of ['frontendDirectory', 'outputDirectory', 'jsonReportPath', 'browserExecutablePath']) {
    assert.ok(typeof options[name] === 'string' && isAbsolute(options[name]), `${name} must be an explicit absolute path`);
    normalized[name] = resolve(options[name]);
  }
  assert.ok(typeof options.backendURL === 'string' && options.backendURL, 'backendURL must be explicitly supplied');
  const backend = new URL(options.backendURL);
  assert.ok(['http:', 'https:'].includes(backend.protocol), 'backendURL must be an explicit HTTP or HTTPS URL');
  return normalized;
}

/** Report records are ordinary parsed JSON, not class instances or accessor-backed objects. */
export function ordinaryJsonRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor);
}

/** Build common policy data; root owns services, output freshness and the original relative auth file. */
export function createBackendCorpusConfigurationData(options, metadata) {
  const { frontendDirectory, backendURL, outputDirectory, jsonReportPath, browserExecutablePath, workers } = normalizeBackendCorpusOptions(options);
  return {
    testDir: join(frontendDirectory, 'tests'), fullyParallel: true, forbidOnly: true,
    retries: 0, repeatEach: 1, workers,
    outputDir: outputDirectory, reporter: [['json', { outputFile: jsonReportPath }]],
    metadata,
    use: { baseURL: backendURL, headless: true, viewport: { width: 1280, height: 720 },
      launchOptions: { executablePath: browserExecutablePath }, trace: 'off', video: 'off', screenshot: 'off' },
    projects: [
      { name: 'setup', testMatch: '**/*.setup.ts' },
      { name: 'chromium', dependencies: ['setup'],
        use: { viewport: { width: 1280, height: 720 }, storageState: 'playwright/.auth/user.json' } },
    ],
  };
}

function reportRecords(report, configuration, issues) {
  const records = [];
  const rootDirectory = configuration.rootDir;
  if (typeof rootDirectory !== 'string' || !isAbsolute(rootDirectory)) issues.push('Missing absolute report rootDir');
  function visit(suites, parents = []) {
    if (!Array.isArray(suites)) { issues.push('Missing report suite inventory'); return; }
    for (const suite of suites) {
      if (!ordinaryJsonRecord(suite)) { issues.push('Malformed report suite'); continue; }
      const suitePath = [...parents, suite.title];
      const specs = Array.isArray(suite.specs) ? suite.specs : [];
      if (!Array.isArray(suite.specs)) issues.push('Missing report spec inventory');
      for (const spec of specs) {
        if (!ordinaryJsonRecord(spec)) { issues.push('Malformed report spec'); continue; }
        if (!Array.isArray(spec.tests)) { issues.push('Missing tests for a reported spec'); continue; }
        for (const test of spec.tests) {
          if (!ordinaryJsonRecord(test)) { issues.push('Malformed reported test'); continue; }
          const originalFile = spec.file ?? suite.file;
          const absoluteFile = typeof originalFile === 'string' && typeof rootDirectory === 'string'
            ? resolve(rootDirectory, originalFile) : undefined;
          const results = Array.isArray(test.results) ? test.results : [];
          if (!Array.isArray(test.results)) issues.push('Missing original result inventory');
          records.push({ id: spec.id, title: spec.title, suitePath, originalFile, absoluteFile,
            line: spec.line, column: spec.column, projectName: test.projectName, projectId: test.projectId,
            expectedStatus: test.expectedStatus, reportedOutcome: test.status, actualStatus: results.at(-1)?.status ?? 'unexecuted',
            results, originalSpec: spec, originalTest: test });
        }
      }
      if (suite.suites !== undefined) visit(suite.suites, suitePath);
    }
  }
  visit(report.suites);
  return records;
}

/** Report timestamp overlap is an observation, not original process identity or resource-coverage proof. */
function reportIntervals(records) {
  const intervals = [], limitations = [];
  for (const record of records.filter(record => record.projectName === 'chromium')) {
    for (const result of record.results) {
      if (!ordinaryJsonRecord(result)) {
        limitations.push({ testId: record.id, reason: 'Malformed original result interval' });
        continue;
      }
      if (result.status === 'skipped') continue;
      const startMilliseconds = typeof result.startTime === 'string' ? Date.parse(result.startTime) : NaN;
      if (!Number.isFinite(startMilliseconds) || !Number.isFinite(result.duration) || result.duration < 0
        || !Number.isInteger(result.workerIndex) || result.workerIndex < 0) {
        limitations.push({ testId: record.id, reason: 'No usable original result interval or assigned worker index' });
        continue;
      }
      intervals.push({ testId: record.id, workerIndex: result.workerIndex, parallelIndex: result.parallelIndex,
        status: result.status, retry: result.retry, startMilliseconds, endMilliseconds: startMilliseconds + result.duration });
    }
  }
  const events = intervals.filter(interval => interval.endMilliseconds > interval.startMilliseconds)
    .flatMap(interval => [{ time: interval.startMilliseconds, change: 1 }, { time: interval.endMilliseconds, change: -1 }])
    .sort((left, right) => left.time - right.time || left.change - right.change);
  let concurrent = 0, maximumOverlappingResultIntervals = 0;
  for (const event of events) {
    concurrent += event.change;
    maximumOverlappingResultIntervals = Math.max(maximumOverlappingResultIntervals, concurrent);
  }
  return { intervals, maximumOverlappingResultIntervals, limitations,
    scope: 'Chromium result timestamps only, excluding serial setup and skipped results. Configured worker count, worker indexes and result overlap do not prove owned worker hosts, application work or resource coverage.' };
}

/** Retain honest Playwright 1.60 JSON outcomes; failures and skips are data, not parser exceptions.
 * Schema source: https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/reporters/json.ts
 */
export function analyzeBackendCorpusReport(report, options, expectedConfiguration, metadataPolicy) {
  const { frontendDirectory, outputDirectory, workers } = normalizeBackendCorpusOptions(options);
  const configurationIssues = [], reportIssues = [];
  const source = ordinaryJsonRecord(report) ? report : {};
  if (source !== report) reportIssues.push('Malformed report root; ordinary parsed JSON object required');
  const configuration = ordinaryJsonRecord(source.config) ? source.config : {};
  if (configuration !== source.config) configurationIssues.push('Malformed report configuration object');
  const records = reportRecords(source, configuration, reportIssues);
  const expected = backendCorpusInventory.files.flatMap(file => file.declarations.map(declaration => ({
    ...declaration, path: file.path, projectName: file.projectName,
    absoluteFile: resolve(frontendDirectory, file.path.slice('frontend/'.length)),
  })));
  const key = record => JSON.stringify([record.projectName, record.absoluteFile, record.title]);
  const expectedByKey = new Map(expected.map(declaration => [key(declaration), declaration]));
  const found = new Set(), reportedIds = new Set(), unexpected = [], duplicates = [], locationMismatches = [];
  for (const record of records) {
    if (typeof record.id !== 'string' || !record.id || reportedIds.has(record.id)) reportIssues.push('Missing or duplicate original test ID');
    reportedIds.add(record.id);
    const identity = key(record), declaration = expectedByKey.get(identity);
    if (!declaration) unexpected.push(record);
    else {
      if (found.has(identity)) duplicates.push(record);
      found.add(identity);
      if (record.line !== declaration.line) locationMismatches.push({ record, expectedLine: declaration.line });
    }
    if (record.results.length > 1 || record.results.some(result => result?.retry !== 0))
      configurationIssues.push(`Original result inventory contains retries: ${record.title}`);
    if (!['expected', 'unexpected', 'flaky', 'skipped'].includes(record.reportedOutcome)) reportIssues.push('Unknown reported test outcome');
    for (const result of record.results) if (!['passed', 'failed', 'timedOut', 'skipped', 'interrupted'].includes(result?.status))
      reportIssues.push('Unknown original result status');
  }
  const missing = expected.filter(declaration => !found.has(key(declaration)));
  const inventoryComplete = records.length === 62 && found.size === 62 && !unexpected.length && !duplicates.length
    && !missing.length && !locationMismatches.length;
  if (configuration.workers !== workers) configurationIssues.push('Reported worker configuration differs from the requested cell');
  const projects = (Array.isArray(configuration.projects) ? configuration.projects : []).filter(project => {
    if (ordinaryJsonRecord(project) && typeof project.name === 'string' && project.name) return true;
    configurationIssues.push('Malformed reported project entry');
    return false;
  });
  if (JSON.stringify(projects.map(project => project.name).sort()) !== JSON.stringify(['chromium', 'setup']))
    configurationIssues.push('Reported project inventory differs from setup plus Chromium');
  for (const project of projects) {
    if (project.retries !== 0 || project.repeatEach !== 1) configurationIssues.push('Reported retry/repeat policy differs');
    if (project.testDir !== join(frontendDirectory, 'tests') || project.outputDir !== outputDirectory)
      configurationIssues.push('Reported test or output directory differs');
  }
  const metadata = ordinaryJsonRecord(configuration.metadata) ? configuration.metadata : {};
  const declaredEngine = ordinaryJsonRecord(metadata[metadataPolicy.key]) ? metadata[metadataPolicy.key] : undefined;
  if (!isDeepStrictEqual(declaredEngine, expectedConfiguration.metadata[metadataPolicy.key]))
    configurationIssues.push(metadataPolicy.mismatchMessage);
  if (metadataPolicy.rejectReference && Object.hasOwn(metadata, 'backendCorpusReference'))
    configurationIssues.push('Candidate report must not declare reference metadata');
  const outcomeCounts = Object.fromEntries(['expected', 'unexpected', 'flaky', 'skipped'].map(status => [status,
    records.filter(record => record.reportedOutcome === status).length]));
  const stats = ordinaryJsonRecord(source.stats) ? source.stats : {};
  for (const [status, count] of Object.entries(outcomeCounts)) if (stats[status] !== count)
    reportIssues.push(`Reported ${status} count differs from retained test outcomes`);
  if (!Array.isArray(source.errors)) reportIssues.push('Missing original report-level error inventory');
  const originalErrors = Array.isArray(source.errors) ? source.errors : [];
  const structureMatchesCorpus = inventoryComplete && !configurationIssues.length && !reportIssues.length;
  return { sourceCommit: inventory.commit, expectedTestCount: 62, expectedSetupCount: 1, expectedChromiumCount: 61,
    configuredWorkers: configuration.workers, requestedWorkers: workers, structureMatchesCorpus,
    inventory: { complete: inventoryComplete, discovered: records.length, matched: found.size, missing, unexpected, duplicates, locationMismatches },
    configurationIssues, reportIssues, outcomeCounts, records, originalErrors, rawReport: report,
    allTestsPassed: structureMatchesCorpus && !originalErrors.length
      && records.every(record => record.reportedOutcome === 'expected' && record.results.length === 1 && record.actualStatus === 'passed'),
    observedOverlap: reportIntervals(records),
    scope: 'Pinned lexical inventory and reported outcomes only. Raw failures/skips/errors are retained. Unchanged source bodies, browser identity/flags/viewport, setup dependency execution, storage-state freshness, owned services, complete clock and process resources require independent controller evidence. This is not final campaign or performance admission.' };
}
