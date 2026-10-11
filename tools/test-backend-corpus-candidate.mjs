import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { analyzeBackendCorpusCandidateReport, backendCorpusInventory, createBackendCorpusCandidateConfigurationData,
  renderBackendCorpusCandidateConfiguration, verifyBackendCorpusCandidateIdentity } from './backend-corpus-candidate.mjs';
import { analyzeBackendCorpusReferenceReport, createBackendCorpusReferenceConfigurationData } from './backend-corpus-reference.mjs';

const options = { candidateWorkspace: '/fixture/native-workspace', frontendDirectory: '/fixture/frontend',
  backendURL: 'http://127.0.0.1:32109', outputDirectory: '/fixture/run/artifacts',
  jsonReportPath: '/fixture/run/report.json', browserExecutablePath: '/fixture/full-chrome/Chrome', workers: 4 };

/** Synthetic report only: declaration matching is independent of actual browser/application admission. */
function reportFixture(parameters = options, configuration = createBackendCorpusCandidateConfigurationData(parameters)) {
  let identityIndex = 0;
  return { config: { rootDir: parameters.frontendDirectory, workers: parameters.workers, metadata: configuration.metadata,
    projects: configuration.projects.map(project => ({ name: project.name, id: project.name,
      testDir: configuration.testDir, outputDir: configuration.outputDir, retries: 0, repeatEach: 1 })) },
    suites: backendCorpusInventory.files.map(file => ({ title: file.path, file: file.path.slice('frontend/'.length),
      specs: file.declarations.map(declaration => ({ id: `candidate-fixture-${identityIndex++}`, title: declaration.title,
        file: file.path.slice('frontend/'.length), line: declaration.line, column: 1,
        tests: [{ projectName: file.projectName, projectId: file.projectName, expectedStatus: 'passed', status: 'expected',
          results: [{ status: 'passed', retry: 0, duration: 5, workerIndex: 0, parallelIndex: 0,
            startTime: '2026-01-01T00:00:00.000Z', errors: [], stdout: [], stderr: [], attachments: [] }] }] })) })),
    errors: [], stats: { expected: 62, unexpected: 0, skipped: 0, flaky: 0 } };
}

function fixtureExports() {
  return { test() {}, request: { newContext() {} }, chromium: { launch() {} } };
}

test('candidate retains identical common runner policy and explicit candidate identity at workers1/4', () => {
  for (const workers of [1, 4]) {
    const candidate = createBackendCorpusCandidateConfigurationData({ ...options, workers });
    const reference = createBackendCorpusReferenceConfigurationData({ ...options, workers });
    const { metadata: candidateMetadata, ...candidatePolicy } = candidate;
    const { metadata: referenceMetadata, ...referencePolicy } = reference;
    assert.deepEqual(candidatePolicy, referencePolicy);
    assert.equal(candidateMetadata.backendCorpusReference, undefined);
    assert.equal(candidateMetadata.backendCorpusCandidate.engine, 'flashwright');
    assert.equal(candidateMetadata.backendCorpusCandidate.referenceContractVersion, '1.60.0');
    assert.equal(candidateMetadata.backendCorpusCandidate.playwrightVersion, undefined);
    assert.equal(candidateMetadata.backendCorpusCandidate.executionClass, 'development-alias-functional-diagnosis');
    assert.equal(referenceMetadata.backendCorpusReference.playwrightVersion, '1.60.0');
    assert.deepEqual(candidate.projects[1].dependencies, ['setup']);
    assert.equal(candidate.projects[1].use.storageState, 'playwright/.auth/user.json');
  }
});

test('candidate requires every absolute path and rejects unknown options and invalid endpoints/workers', () => {
  const paths = ['candidateWorkspace', 'frontendDirectory', 'outputDirectory', 'jsonReportPath', 'browserExecutablePath'];
  for (const name of paths) for (const value of [undefined, '', 'relative/path', 42])
    assert.throws(() => renderBackendCorpusCandidateConfiguration({ ...options, [name]: value }));
  for (const workers of [undefined, 0, 2, 8, '4'])
    assert.throws(() => analyzeBackendCorpusCandidateReport({}, { ...options, workers }));
  for (const backendURL of [undefined, '', 'not-a-url', 'file:///fixture/backend'])
    assert.throws(() => createBackendCorpusCandidateConfigurationData({ ...options, backendURL }));
  assert.throws(() => renderBackendCorpusCandidateConfiguration({ ...options, browserChannel: 'guessed' }), /Unsupported candidate option/);
  assert.throws(() => renderBackendCorpusCandidateConfiguration({ ...options, [Symbol('unknown')]: true }), /Unsupported candidate option/);
  let accessorCalls = 0;
  const accessorOptions = Object.defineProperty({ ...options }, 'candidateWorkspace', { get() { accessorCalls++; } });
  assert.throws(() => renderBackendCorpusCandidateConfiguration(accessorOptions), /without accessors/);
  assert.equal(accessorCalls, 0);
});

test('candidate checks all three identities and rejects missing canonical exports even when aliases also omit them', () => {
  const canonical = fixtureExports();
  assert.doesNotThrow(() => verifyBackendCorpusCandidateIdentity({ ...canonical }, canonical));
  for (const name of ['test', 'request', 'chromium']) {
    assert.throws(() => verifyBackendCorpusCandidateIdentity({ ...canonical, [name]: fixtureExports()[name] }, canonical),
      new RegExp(`${name} identity differs`));
    const missing = { ...canonical, [name]: undefined };
    assert.throws(() => verifyBackendCorpusCandidateIdentity(missing, missing), new RegExp(`missing a usable ${name}`));
    assert.throws(() => verifyBackendCorpusCandidateIdentity(canonical, { ...canonical, [name]: {} }),
      new RegExp(`missing a usable ${name}`));
  }
});

test('complete candidate report retains all62 original identities and raw object ownership', () => {
  const report = reportFixture(), original = structuredClone(report);
  const analysis = analyzeBackendCorpusCandidateReport(report, options);
  assert.equal(analysis.structureMatchesCorpus, true);
  assert.equal(analysis.allTestsPassed, true);
  assert.equal(analysis.inventory.discovered, 62);
  assert.equal(analysis.expectedSetupCount, 1);
  assert.equal(analysis.expectedChromiumCount, 61);
  assert.equal(analysis.engine, 'flashwright');
  assert.strictEqual(analysis.rawReport, report);
  assert.strictEqual(analysis.records[0].originalSpec, report.suites[0].specs[0]);
  assert.strictEqual(analysis.records[0].results, report.suites[0].specs[0].tests[0].results);
  assert.deepEqual(report, original);
});

test('candidate and reference reports reject each other despite matching unchanged62 inventory', () => {
  const candidate = reportFixture();
  const reference = reportFixture(options, createBackendCorpusReferenceConfigurationData(options));
  for (const [report, analyze] of [[candidate, analyzeBackendCorpusReferenceReport], [reference, analyzeBackendCorpusCandidateReport]]) {
    const analysis = analyze(report, options);
    assert.equal(analysis.inventory.complete, true);
    assert.equal(analysis.structureMatchesCorpus, false);
    assert.equal(analysis.allTestsPassed, false);
    assert.strictEqual(analysis.rawReport, report);
    assert.ok(analysis.configurationIssues.some(issue => issue.includes('metadata differs')));
  }
});

test('candidate metadata binds canonical workspace, native identity, browser path and reference contract independently', () => {
  for (const [name, value] of [['engine', 'playwright'], ['candidateWorkspace', '/different/workspace'],
    ['backendGuardPath', '/different/guard.mjs'], ['browserExecutablePath', '/different/browser'],
    ['jsonReportPath', '/different/report.json'], ['outputDirectory', '/different/output'],
    ['referenceContractVersion', '1.63.0'], ['requiredIdenticalExports', ['test']], ['workers', 1]]) {
    const report = reportFixture();
    report.config.metadata.backendCorpusCandidate[name] = value;
    const analysis = analyzeBackendCorpusCandidateReport(report, options);
    assert.equal(analysis.inventory.complete, true);
    assert.equal(analysis.structureMatchesCorpus, false);
    assert.equal(analysis.allTestsPassed, false);
    assert.ok(analysis.configurationIssues.some(issue => issue.startsWith('Declared candidate metadata differs')));
    assert.strictEqual(analysis.rawReport, report);
  }
  const report = reportFixture();
  report.config.metadata.backendCorpusReference = createBackendCorpusReferenceConfigurationData(options).metadata.backendCorpusReference;
  assert.ok(analyzeBackendCorpusCandidateReport(report, options).configurationIssues.includes('Candidate report must not declare reference metadata'));
  assert.equal(analyzeBackendCorpusCandidateReport(reportFixture(), { ...options, jsonReportPath: '/different/report.json' }).structureMatchesCorpus, false);
});

test('candidate preserves failures, skips, diagnostic objects and forbidden retry attempts', () => {
  const report = reportFixture(), tests = report.suites.flatMap(suite => suite.specs.flatMap(spec => spec.tests));
  tests[0].status = 'unexpected';
  Object.assign(tests[0].results[0], { status: 'timedOut', errors: [{ message: 'Original candidate timeout', stack: 'original stack' }],
    stdout: [{ text: 'original stdout' }], attachments: [{ name: 'original candidate artifact', path: '/fixture/original.zip' }] });
  tests[1].status = 'skipped'; tests[1].results = [];
  report.stats = { expected: 60, unexpected: 1, skipped: 1, flaky: 0 };
  const original = structuredClone(report), analysis = analyzeBackendCorpusCandidateReport(report, options);
  assert.equal(analysis.structureMatchesCorpus, true);
  assert.equal(analysis.allTestsPassed, false);
  assert.deepEqual(analysis.outcomeCounts, report.stats);
  assert.strictEqual(analysis.records[0].results[0].errors, tests[0].results[0].errors);
  assert.deepEqual(report, original);
  tests[2].results.push({ ...structuredClone(tests[2].results[0]), retry: 1 });
  const retried = analyzeBackendCorpusCandidateReport(report, options);
  assert.equal(retried.structureMatchesCorpus, false);
  assert.equal(retried.records[2].results.length, 2);
  assert.ok(retried.configurationIssues.some(issue => issue.includes('retries')));
});

test('candidate malformed metadata/report objects retain diagnostics without evaluating accessors', () => {
  for (const report of [null, 42, []]) {
    const analysis = analyzeBackendCorpusCandidateReport(report, options);
    assert.equal(analysis.structureMatchesCorpus, false);
    assert.strictEqual(analysis.rawReport, report);
  }
  let accessorCalls = 0;
  const report = reportFixture();
  Object.defineProperty(report.config.metadata, 'backendCorpusCandidate', { get() { accessorCalls++; throw new Error('Do not evaluate'); } });
  const analysis = analyzeBackendCorpusCandidateReport(report, options);
  assert.equal(analysis.structureMatchesCorpus, false);
  assert.strictEqual(analysis.rawReport, report);
  assert.equal(accessorCalls, 0);
});

/** Tiny fake package trees exercise actual generated config loading; native methods are never called. */
async function loadGeneratedFixture({ replacement, missingChromium = false, wrongDirectory = false, workers = 4 } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'flashwright-candidate-config-')));
  try {
    const candidateWorkspace = join(directory, 'workspace with "quotes"'), frontendDirectory = join(directory, 'frontend with\nnewline');
    const canonicalDirectory = join(candidateWorkspace, 'node_modules/@flashwright/test');
    const aliasDirectory = join(frontendDirectory, 'node_modules/@playwright/test');
    await Promise.all([mkdir(canonicalDirectory, { recursive: true }), mkdir(aliasDirectory, { recursive: true }),
      mkdir(join(candidateWorkspace, 'benchmarks'), { recursive: true })]);
    for (const root of [candidateWorkspace, frontendDirectory]) await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    for (const [root, name] of [[canonicalDirectory, '@flashwright/test'], [aliasDirectory, '@playwright/test']])
      await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '1.60.0', main: 'index.cjs' }));
    await writeFile(join(canonicalDirectory, 'index.cjs'), `const events = [];
module.exports = { test() { events.push('test'); }, request: { newContext() { events.push('request'); } },
  chromium: { launch() { events.push('chromium'); } }, events,
  defineConfig(value) { events.push('defineConfig'); return value; },
  devices: { 'Desktop Chrome': { userAgent: 'fixture-native-agent', screen: { width: 1920, height: 1080 },
    viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, defaultBrowserType: 'chromium' } } };
${missingChromium ? 'delete module.exports.chromium;' : ''}
`);
    const replacementSource = replacement ? `canonical.${replacement} = ${replacement === 'test' ? 'function differentTest() {}'
      : replacement === 'request' ? '{ newContext() {} }' : '{ launch() {} }'};` : '';
    await writeFile(join(aliasDirectory, 'index.cjs'), `const canonical = { ...require(${JSON.stringify(join(canonicalDirectory, 'index.cjs'))}) };
${replacementSource}
module.exports = canonical;
`);
    const guardPath = join(candidateWorkspace, 'benchmarks/native-backend-guard.mjs');
    await writeFile(guardPath, 'let count = 0; export function forbidUpstreamBrowserBackend() { count++; } export function installations() { return count; }\n');
    const parameters = { ...options, candidateWorkspace, frontendDirectory, workers,
      outputDirectory: join(directory, 'artifacts'), jsonReportPath: join(directory, 'report.json'),
      browserExecutablePath: join(directory, 'declared-browser') };
    const configurationPath = join(directory, 'candidate.config.mjs');
    await writeFile(configurationPath, renderBackendCorpusCandidateConfiguration(parameters));
    const entryPath = join(directory, 'entry.mjs');
    await writeFile(entryPath, `import { createRequire } from 'node:module';
import { installations } from ${JSON.stringify(pathToFileURL(guardPath).href)};
const canonical = createRequire(${JSON.stringify(join(candidateWorkspace, 'package.json'))})('@flashwright/test');
let configuration, error;
try { configuration = (await import(${JSON.stringify(pathToFileURL(configurationPath).href)})).default; }
catch (failure) { error = failure.message; }
process.stdout.write(JSON.stringify({ configuration, error, guardInstallations: installations(), events: canonical.events }));
`);
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [entryPath], {
      cwd: wrongDirectory ? candidateWorkspace : frontendDirectory, timeout: 5000, maxBuffer: 131072, killSignal: 'SIGKILL' });
    assert.equal(stderr, '');
    return { observed: JSON.parse(stdout), parameters };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('generated config loads the actual frontend alias and workspace guard with identical common policies', async () => {
  for (const workers of [1, 4]) {
    const { observed, parameters } = await loadGeneratedFixture({ workers });
    assert.equal(observed.error, undefined);
    assert.equal(observed.guardInstallations, 1);
    assert.deepEqual(observed.events, ['defineConfig']);
    assert.equal(observed.configuration.workers, workers);
    assert.equal(observed.configuration.projects[1].use.userAgent, 'fixture-native-agent');
    assert.deepEqual(observed.configuration.projects[1].use.viewport, { width: 1280, height: 720 });
    assert.deepEqual(observed.configuration.metadata, createBackendCorpusCandidateConfigurationData(parameters).metadata);
  }
});

test('generated config rejects each wrong identity before guard installation or any fixture/native call', async () => {
  for (const replacement of ['test', 'request', 'chromium']) {
    const { observed } = await loadGeneratedFixture({ replacement });
    assert.match(observed.error, new RegExp(`${replacement} identity differs`));
    assert.equal(observed.guardInstallations, 0);
    assert.deepEqual(observed.events, []);
    assert.equal(observed.configuration, undefined);
  }
});

test('generated config rejects undefined chromium identity and foreign cwd before guard/fixture entry', async () => {
  const missing = await loadGeneratedFixture({ missingChromium: true });
  assert.match(missing.observed.error, /missing a usable chromium/);
  const foreign = await loadGeneratedFixture({ wrongDirectory: true });
  assert.match(foreign.observed.error, /Run the candidate from its frontend directory/);
  for (const { observed } of [missing, foreign]) {
    assert.equal(observed.guardInstallations, 0);
    assert.deepEqual(observed.events, []);
    assert.equal(observed.configuration, undefined);
  }
});
