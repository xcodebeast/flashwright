import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { hash } from './competitor-inputs.mjs';
import { numericApplicationObservations } from './application-snapshot.mjs';
import { normalizeRunnerMatrixEvidence, runnerMatrixEvidenceFiles, verifyPortableRunnerEvidence, verifyRunnerMatrixSnapshot } from './runner-matrix-snapshot.mjs';
import { verifyRunnerFailureDiagnostics } from '../benchmarks/runner-suite-diagnostics.mjs';
import { verifyRunnerSuite, renderRunnerSuiteAdmission } from '../benchmarks/runner-suite-contract.mjs';
import { renderRunnerMatrixReport } from '../benchmarks/runner-matrix-contract.mjs';

const configurationBytes = await readFile(new URL('../benchmarks/configurations/runner-suite.json', import.meta.url));
const policyBytes = await readFile(new URL('../crates/flashwright-browser/src/chromium-launch-policy.json', import.meta.url));
const commonSource = await readFile(new URL('../benchmarks/runner-suite/workloads.spec.mjs', import.meta.url));
const configuration = JSON.parse(configurationBytes);
const policy = JSON.parse(policyBytes);
const serialize = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const hashes = files => Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, hash(bytes)]));
const mappings = [{ original: '/Users/example/checkout', replacement: '/workspace' },
  { original: '/Users/example/Chrome Testing', replacement: '/browser/executable' },
  { original: '../../../../p/example/.cache/matrix', replacement: '/retained/runner-matrix', relativePath: true }];
const evidence = text => ({ 'sample.json': Buffer.from(text) });

test('exact roots, URLs and original ANSI cursor boundaries normalize without changing numbers or ANSI', () => {
  const original = '/Users/example/checkout/project file file:///Users/example/Chrome%20Testing\n\u001b[1A\u001b[2K../../../../p/example/.cache/matrix/pair-00/project\n\\u001b[1A\\u001b[2K../../../../p/example/.cache/matrix/pair-00/project\n123.456';
  const normalized = normalizeRunnerMatrixEvidence(evidence(original), mappings)['sample.json'].toString();
  assert.equal(normalized, '/workspace/project file file:///browser/executable\n\u001b[1A\u001b[2K/retained/runner-matrix/pair-00/project\n\\u001b[1A\\u001b[2K/retained/runner-matrix/pair-00/project\n123.456');
});

for (const path of ['/Users/example/checkout-sibling/a', '/Users/unknown/a', '/home/unknown/a', '/tmp/unknown/a', '/private/var/tmp/a', 'file:///%55sers/unknown/a', '/workspace/%2e%2e/private', 'prefix/Users/example/checkout/a']) {
  test(`rejects unknown or escaped private path ${path}`, () => assert.throws(() => normalizeRunnerMatrixEvidence(evidence(path), mappings), /private path|percent-escaped/));
}

test('ordinary letter prefixes never authorize relative path rewriting', () => {
  assert.throws(() => normalizeRunnerMatrixEvidence(evidence('prefix../../../../p/example/.cache/matrix/pair-00'), mappings), /private relative path/);
});

for (const original of ['/Users/example', '/home/example', '/var/folders/ab/example/T', '/tmp']) {
  test(`rejects broad normalization root ${original}`, () => assert.throws(() => normalizeRunnerMatrixEvidence(evidence('safe'), [{ original, replacement: '/workspace' }])));
}

for (const bytes of [Buffer.from([0]), Buffer.from([255]), Buffer.from([0xc3])]) {
  test(`rejects binary or invalid UTF-8 log ${bytes.toString('hex')}`, () => assert.throws(() => normalizeRunnerMatrixEvidence({ 'stderr.txt': bytes }, [])));
}

function reporterFiles(entries, stream = 'stderr') {
  const runner = { suites: [{ suites: [{ specs: [{ tests: [{ results: [{ duration: 123.456, [stream]: entries }] }] }] }] }] };
  const joined = Buffer.concat(entries.map(entry => entry.text !== undefined ? Buffer.from(entry.text) : Buffer.from(entry.buffer, 'base64'))).toString();
  const report = { completeMilliseconds: 567.89, [stream === 'stderr' ? 'runnerStderr' : 'runnerStdout']: joined, runner };
  return { 'pair-00-flashwright/runner-report.json': serialize(runner), 'pair-00-flashwright/sample.json': serialize(report), 'pair-00-flashwright/stdout.txt': Buffer.from(JSON.stringify(report) + '\n') };
}

function streamText(bytes, raw = false, stream = 'stderr') {
  const document = JSON.parse(bytes);
  const runner = raw ? document : document.runner;
  return runner.suites[0].suites[0].specs[0].tests[0].results[0][stream].map(entry => entry.text ?? Buffer.from(entry.buffer, 'base64').toString()).join('');
}

for (const stream of ['stdout', 'stderr']) test(`normalizes the real reporter buffer form across path and UTF-8 boundaries in ${stream}`, () => {
  const original = '\u001b[2Kflashwright:browser <launching> {"executable":"/Users/example/Chrome Testing","arguments":["--flag"]}\nUnicode: æ🙂\n';
  const bytes = Buffer.from(original);
  const cuts = [original.indexOf('/Users') + 8, bytes.indexOf(Buffer.from('æ')) + 1, bytes.length - 1];
  const chunks = [];
  let offset = 0;
  for (const cut of [...cuts, bytes.length]) { chunks.push({ buffer: bytes.subarray(offset, cut).toString('base64') }); offset = cut; }
  const files = reporterFiles(chunks, stream);
  const normalized = normalizeRunnerMatrixEvidence(files, mappings);
  const expected = original.replace('/Users/example/Chrome Testing', '/browser/executable');
  for (const [path, output] of Object.entries(normalized)) {
    assert.equal(streamText(output, path.endsWith('/runner-report.json'), stream), expected);
    assert.deepEqual(numericApplicationObservations(JSON.parse(output)), numericApplicationObservations(JSON.parse(files[path])));
    const document = JSON.parse(output);
    if (document.runner) assert.equal(document[stream === 'stderr' ? 'runnerStderr' : 'runnerStdout'], expected, 'Live-forwarded copy and recorded reporter stream must stay equal');
    const runner = document.runner ?? document;
    const entries = runner.suites[0].suites[0].specs[0].tests[0].results[0][stream];
    assert.equal(entries.length, chunks.length);
    assert.ok(entries.every(entry => Object.keys(entry).join() === 'text'));
  }
  assert.deepEqual(JSON.parse(normalized['pair-00-flashwright/sample.json']).runner, JSON.parse(normalized['pair-00-flashwright/runner-report.json']));
  assert.deepEqual(normalizeRunnerMatrixEvidence(normalized, []), normalized, 'Independent portable stream inspection must be idempotent');
});

test('mixed reporter text/buffer chunks normalize relative paths spanning representations while retaining every byte', () => {
  const chunks = [{ text: '\u001b[2K../../../../p/example/' }, { buffer: Buffer.from('.cache/matrix/pair-00').toString('base64') }, { text: '/project\n123.456\n' }];
  const output = normalizeRunnerMatrixEvidence(reporterFiles(chunks), mappings);
  assert.equal(streamText(output['pair-00-flashwright/sample.json']), '\u001b[2K/retained/runner-matrix/pair-00/project\n123.456\n');
});

for (const buffer of ['AA', 'AA==\n', 'AA--', 'AB==', '!!!!', Buffer.from([255]).toString('base64'), Buffer.from([0]).toString('base64')]) {
  test(`rejects malformed base64, binary or invalid UTF-8 reporter bytes ${buffer}`, () => assert.throws(() => normalizeRunnerMatrixEvidence(reporterFiles([{ buffer }]), [])));
}

test('independent privacy validation inspects encoded reporter streams and rejects hidden private paths', () => {
  for (const privatePath of ['/Users/unknown/private', 'file:///%55sers/unknown/private', '/tmp/unknown/private']) {
    const chunks = [{ buffer: Buffer.from(privatePath.slice(0, 4)).toString('base64') }, { buffer: Buffer.from(privatePath.slice(4)).toString('base64') }];
    const rawReportPath = 'pair-00-flashwright/runner-report.json';
    const encodedOnly = { [rawReportPath]: reporterFiles(chunks)[rawReportPath] };
    assert.throws(() => normalizeRunnerMatrixEvidence(encodedOnly, []), /private path/);
    const snapshotFiles = Object.fromEntries(Object.entries(encodedOnly).map(([path, bytes]) => [`evidence/${path}`, bytes]));
    assert.throws(() => normalizeRunnerMatrixEvidence(snapshotFiles, []), /private path/);
  }
  assert.throws(() => normalizeRunnerMatrixEvidence(reporterFiles([{ text: 'safe', buffer: 'c2FmZQ==' }]), []), /exactly text or buffer/);
});

const sourceLines = commonSource.toString().split('\n');
const assertionLine = sourceLines.findIndex(line => line.includes("await expect(page.locator('#missing')).toBeVisible")) + 1;
const declarationLine = sourceLines.findIndex(line => line.includes('test(`${workload}/${phase}/${iteration}`')) + 1;
const assertionColumn = sourceLines[assertionLine - 1].indexOf('.toBeVisible') + 1;
const declarationColumn = sourceLines[declarationLine - 1].indexOf('test(');
const snapshot = '- text: Name\n- textbox "Name"\n- button "Increment"\n- button "Save"\n- status: Ready\n- text: "0"';
const message = 'Error: expect(locator("#missing")).toBeVisible(expected)\nTimed out after 250ms\nLocator: locator("#missing")\nExpected: "visible"\nReceived: no matching element';

function sourceFrame(fullSource) {
  const frame = [];
  const first = fullSource ? 1 : assertionLine - 2;
  const last = fullSource ? sourceLines.length : assertionLine + 3;
  for (let number = first; number <= last; number++) {
    const padding = fullSource ? ' '.repeat(String(sourceLines.length).length - String(number).length + 1) : ' ';
    frame.push(`${number === assertionLine ? '>' : ' '} ${number}${padding}| ${sourceLines[number - 1]}`);
    if (number === assertionLine) frame.push(`     | ${' '.repeat(assertionColumn - 1)}^${fullSource ? ` ${message.split('\n')[0]}` : ''}`);
  }
  return frame.join('\n');
}

async function writeFiles(directory, files) {
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), bytes);
  }
}

/** Full synthetic matrix uses the real preserved fixture and admission code, with no browser or live binary. */
async function portableFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'runner-matrix-snapshot-'));
  const files = {};
  const sources = { 'benchmarks/runner-suite/workloads.spec.mjs': hash(commonSource), 'benchmarks/configurations/runner-suite.json': hash(configurationBytes),
    'crates/flashwright-browser/src/chromium-launch-policy.json': hash(policyBytes), 'packages/flashwright-test/package.json': 'a'.repeat(64), 'tools/verify-runner-suite.mjs': 'b'.repeat(64) };
  const preflight = { status: 'verified-engine-with-reviewed-harness-delta', sourceCommit: 'a'.repeat(40), sources, driverSha256: 'c'.repeat(64), browser: { sha256: 'd'.repeat(64), version: configuration.browserVersion,
    versionOutput: `Chromium ${configuration.browserVersion}`, distribution: 'full-chromium' }, coreReportSha256: 'e'.repeat(64), originalCoreGroups: 179, originalCoreSourceCommit: '666a2a8f' };
  files['source-preflight.json'] = serialize(preflight);
  files['plan.json'] = serialize({ independentPairs: 8, engines: ['playwright', 'flashwright'], sourceCommitPrefix: 'aaaaaaaa', expectedFailureTimeoutMilliseconds: 250 });
  files['machine.json'] = serialize({ schemaVersion: 1, recordedAt: '2026-10-10T15:50:52.188Z', platform: 'darwin', architecture: 'arm64', operatingSystem: 'Synthetic Darwin', cpu: 'Synthetic CPU', logicalProcessors: 8, totalMemoryBytes: 1000000000,
    runtime: { name: 'bun', version: '1.4.2' }, headless: true, workers: 1, scope: 'Stable machine identity recorded during collection; no initial-load or exclusive-host claim.' });
  files['environmental-confound.json'] = serialize({ performanceAccepted: false, creationOperation: 'private-worktree-creation', event: 'Synthetic environmental confound' });
  files['first-pair-admission.json'] = serialize({ status: 'passed-first-pair-content-admission', pair: 0, originalFailureDocumentsPerEngine: 15, independentVerifierExitCodes: [0, 0],
    matchingFields: ['sourceSha256', 'snapshotSha256', 'normalizedSourceFrameSha256', 'callSite', 'retainedPredicateObservation'] });
  for (let index = 0; index < 8; index++) for (const engine of ['playwright', 'flashwright']) {
    const root = `pair-${String(index).padStart(2, '0')}-${engine}`;
    const engineOrder = index % 2 ? ['flashwright', 'playwright'] : ['playwright', 'flashwright'];
    const runSequence = index * 2 + engineOrder.indexOf(engine);
    const recordedDirectory = `/retained/runner-matrix/${root}`;
    const sourcePath = `${recordedDirectory}/project/workloads.spec.mjs`;
    const runtime = { name: 'bun', version: '1.4.2' };
    const browser = { executablePath: '/browser/executable', ...preflight.browser };
    const runnerConfiguration = { testDir: '.', testMatch: 'workloads.spec.mjs', workers: 1, retries: 0, repeatEach: 1, fullyParallel: false, maxFailures: 0, forbidOnly: true, timeout: 30000,
      expect: { timeout: 5000 }, outputDir: `${recordedDirectory}/test-output`, reporter: [['json', { outputFile: `${recordedDirectory}/runner-report.json` }]],
      use: { headless: true, viewport: configuration.viewport, launchOptions: { executablePath: browser.executablePath }, trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 5000, navigationTimeout: 10000 } };
    const run = { 'project/workloads.spec.mjs': commonSource, 'project/suite-configuration.json': serialize({ configuration, launchIndex: index }), 'stderr.txt': Buffer.from(''), 'test-output/.last-run.json': serialize({ status: 'failed', failedTests: [] }) };
    const guard = engine === 'flashwright' ? 'import { forbidUpstreamBrowserBackend } from "file:///workspace/benchmarks/native-backend-guard.mjs";\nforbidUpstreamBrowserBackend();\n' : '';
    run['project/adapter.mjs'] = Buffer.from(`${guard}export { test, expect, defineConfig } from "file:///workspace/${engine === 'playwright' ? 'node_modules/@playwright/test/index.mjs' : 'packages/flashwright-test/dist/esm/index.js'}";\nexport const nativeBackendGuardActive = ${engine === 'flashwright'};\n`);
    run['project/runner.config.mjs'] = Buffer.from(`import { defineConfig } from './adapter.mjs';\nconst configuration = ${JSON.stringify(runnerConfiguration)};\nconfiguration.use.baseURL = process.env.FLASHWRIGHT_TEST_BASE_URL;\nexport default defineConfig(configuration);\n`);
    const launch = { configuration, engine, launchIndex: index, browser, driverPath: '/driver/executable', driverSha256: preflight.driverSha256,
      runnerCommand: [engine === 'playwright' ? '/workspace/node_modules/playwright/cli.js' : '/workspace/packages/flashwright-test/cli.cjs', 'test', '--config', `${recordedDirectory}/project/runner.config.mjs`] };
    run['launch-inputs.json'] = serialize(launch);
    const inputs = { sources, dependencies: { 'node_modules/@playwright/test/index.mjs': 'f'.repeat(64), 'node_modules/@flashwright/test/package.json': '1'.repeat(64) }, browser,
      driverPath: '/driver/executable', driverSha256: preflight.driverSha256, runtime: { executable: '/runtime/executable', sha256: '2'.repeat(64) }, runnerConfiguration,
      generatedFiles: hashes(Object.fromEntries(Object.entries(run).filter(([path]) => path.startsWith('project/') || path === 'launch-inputs.json'))) };
    const specifications = [];
    const offset = index % configuration.workloads.length;
    const workloads = configuration.workloads.slice(offset).concat(configuration.workloads.slice(0, offset));
    for (const workload of workloads) for (const [phase, count] of [['warmup', 3], ['sample', 12]]) for (let iteration = 0; iteration < count; iteration++) {
      const title = `${workload}/${phase}/${iteration}`;
      const failure = workload === 'failure';
      const result = { status: failure ? 'failed' : 'passed', retry: 0, parallelIndex: 0, workerIndex: 0, duration: 100 + iteration, errors: [], attachments: [], stderr: [],
        annotations: [{ type: 'runner-suite-observation', description: JSON.stringify({ title, isolation: { localStorage: null, sessionStorage: null, cookies: '' }, contextReused: false,
          browserVersion: configuration.browserVersion, nativeBackendGuardActive: engine === 'flashwright', runtime, workerProcess: 1,
          trustedClicks: ['interaction', 'backend'].includes(workload) ? 1 : 0, untrustedClicks: 0, trustedChanges: workload === 'backend' ? 1 : 0, untrustedChanges: 0,
          applicationCount: workload === 'interaction' ? 1 : 0, viewport: configuration.viewport, focused: true, visibilityState: 'visible', milliseconds: 50 + iteration }) }] };
      if (failure) {
        const location = { file: sourcePath, line: assertionLine, column: assertionColumn };
        const stack = `    at ${sourcePath}:${assertionLine}:${assertionColumn}`;
        const snippet = sourceFrame(false);
        result.error = { location, message, stack: `${message}\n${stack}`, snippet };
        result.errorLocation = { ...location };
        result.errors = [{ location: { ...location }, message: `${message}\n\n${snippet}\n${stack}` }];
        const documentPath = `test-output/workloads-${title.replaceAll('/', '-')}/error-context.md`;
        result.attachments = [{ name: 'error-context', contentType: 'text/markdown', path: `${recordedDirectory}/${documentPath}` }];
        run[documentPath] = Buffer.from(`# Test info\n\n- Name: workloads.spec.mjs >> ${title}\n- Location: ${sourcePath}:${declarationLine}:${declarationColumn}\n\n# Error details\n\n\`\`\`\n${message}\n\`\`\`\n\n\`\`\`yaml\n${snapshot}\n\`\`\`\n\n# Test source\n\n\`\`\`ts\n${sourceFrame(true)}\n\`\`\`\n`);
      }
      specifications.push({ title, file: 'workloads.spec.mjs', line: declarationLine, column: declarationColumn,
        tests: [{ expectedStatus: 'passed', status: failure ? 'unexpected' : 'expected', results: [result] }] });
    }
    const arguments_ = policy.headless.map(argument => argument.replace('__FLASHWRIGHT_PROFILE__', '/environment/browser-profile-0'));
    const runnerStderr = engine === 'playwright' ? `pw:browser <launching> ${browser.executablePath} ${arguments_.join(' ')}\n`
      : `flashwright:browser <launching> ${JSON.stringify({ executable: browser.executablePath, arguments: arguments_ })}\n`;
    const launchPrefixLength = runnerStderr.indexOf('<launching> ') + '<launching> '.length;
    specifications[0].tests[0].results[0].stderr = [{ buffer: Buffer.from(runnerStderr.slice(0, launchPrefixLength)).toString('base64') },
      { buffer: Buffer.from(runnerStderr.slice(launchPrefixLength)).toString('base64') }];
    const report = { engine, launchIndex: index, runtime, comparisonClass: 'runner-fixture', configuration, browser, driverSha256: preflight.driverSha256, failures: [], runnerExit: { code: 1, signal: null },
      completeMilliseconds: 20000 + index, runnerStderr, backend: { documents: 120, backendRequests: 15 }, runner: { errors: [], config: { configFile: launch.runnerCommand[3], workers: 1, fullyParallel: false, maxFailures: 0, projects: [{ retries: 0, repeatEach: 1 }] },
        suites: [{ specs: specifications }], stats: { expected: 90, unexpected: 15, flaky: 0, skipped: 0, duration: 19000 + index,
          startTime: new Date(Date.parse('2026-10-10T00:00:00.000Z') + runSequence * 30000).toISOString() } } };
    const resources = { schemaVersion: 2, exitCode: 0, timedOut: false, interrupted: false, remainingObservedProcesses: [], cleanupSignals: [], processes: [{ process: 1 }],
      maximumSampledConcurrentRssBytes: 1000000 + index, observedCpuSeconds: 2, elapsedSeconds: 30, command: ['/runtime/executable', 'benchmarks/runner-suite-sample.mjs', recordedDirectory] };
    run['inputs.json'] = serialize(inputs);
    run['sample.json'] = serialize(report);
    run['stdout.txt'] = serialize(report);
    run['runner-report.json'] = serialize(report.runner);
    run['resources.json'] = serialize(resources);
    const reporterDocuments = normalizeRunnerMatrixEvidence(Object.fromEntries(['sample.json', 'stdout.txt', 'runner-report.json'].map(path => [`${root}/${path}`, run[path]])), []);
    for (const [path, bytes] of Object.entries(reporterDocuments)) run[path.slice(root.length + 1)] = bytes;
    await writeFiles(join(directory, 'evidence', root), run);
    const diagnosticAdmission = await verifyRunnerFailureDiagnostics(report, join(directory, 'evidence', root), { recordedDirectory });
    const admission = { status: 'passed-runner-outcomes', exit: { code: 0, signal: null }, inputsUnchanged: true, ...verifyRunnerSuite(report, resources, configuration, policy), diagnosticAdmission };
    run['table.md'] = Buffer.from(renderRunnerSuiteAdmission(report, admission));
    admission.files = hashes(run);
    run['admission.json'] = serialize(admission);
    for (const [path, bytes] of Object.entries(run)) files[`${root}/${path}`] = bytes;
  }
  await writeFiles(join(directory, 'evidence'), files);
  const analysis = await verifyPortableRunnerEvidence(files, join(directory, 'evidence'), configuration, policy);
  const exported = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [`evidence/${path}`, bytes]));
  exported['configuration.json'] = configurationBytes;
  exported['chromium-launch-policy.json'] = policyBytes;
  exported['matrix-result.json'] = serialize(analysis);
  exported['table.md'] = Buffer.from(renderRunnerMatrixReport(analysis));
  const exportToolSources = { 'tools/runner-matrix-snapshot.mjs': '3'.repeat(64) };
  exported['commands.json'] = serialize({ measuredSourceCommit: preflight.sourceCommit, recordedVerifierSha256: sources['tools/verify-runner-suite.mjs'], exportToolSources,
    recordedVerification: ['/runtime/exporter', '/workspace/tools/verify-runner-suite.mjs', '/retained/runner-matrix/PAIR'] });
  const manifest = { schemaVersion: 1, kind: 'portable-runner-matrix', originalVerification: 'recorded-source-checkout-with-live-identities', portableVerification: 'independent-retained-custody-and-semantic-admission',
    liveExecutableBytesVerified: false, installedDependencyBytesVerified: false, sourceIdentitiesPreserved: true, numericObservationsPreserved: true,
    redactions: [{ file: 'environmental-confound.json', field: 'creationOperation', replacement: 'private-worktree-creation', reason: 'Private desktop worktree operation identity; original file byte hash retained.' }],
    reporterStreamNormalization: {
      fields: 'runner.suites[].specs[].tests[].results[].stdout and stderr; recursively nested suites; runner-report.json uses the runner root',
      representation: 'UTF-8 text chunks, retaining the original chunk count and ordered joined content. Original chunk encoding and boundaries may change.',
      content: 'Joined byte content changes only through declared exact path normalization. Original file hashes retain exact original chunk evidence.',
    },
    originalFiles: hashes(files), originalNumericObservationHashes: Object.fromEntries(Object.entries(files).filter(([path]) => path.endsWith('.json')).map(([path, bytes]) => [path, hash(serialize(numericApplicationObservations(JSON.parse(bytes))))])),
    exportedFiles: hashes(exported), recordedSources: sources, sourceCommit: preflight.sourceCommit, exportToolSources,
    coreReceiptReference: { sha256: preflight.coreReportSha256, groups: 179, sourceCommit: '666a2a8f', rerun: false } };
  await writeFiles(directory, { ...exported, 'manifest.json': serialize(manifest) });
  return { directory, files, manifest };
}

let fixturePromise;
async function withFixture(run) {
  fixturePromise ??= portableFixture();
  const state = await fixturePromise;
  return run(state);
}
test.after(async () => { if (fixturePromise) await rm((await fixturePromise).directory, { recursive: true, force: true }); });

test('independent portable verifier admits all sixteen runs and unchanged numbers without historical live files', { timeout: 60000 }, () => withFixture(async state => {
  const { analysis } = await verifyRunnerMatrixSnapshot(state.directory);
  assert.equal(analysis.independentPairs, 8);
  assert.equal(analysis.testsPerEngine, 840);
  assert.equal(analysis.defaultFailureDocumentsPerEngine, 120);
  assert.equal(analysis.performanceAccepted, false);
}));

test('raw diagnostics defaults still require actual recorded paths while portable mapping admits only the verified suffix', { timeout: 60000 }, () => withFixture(async state => {
  const root = 'pair-00-flashwright';
  const report = JSON.parse(state.files[`${root}/sample.json`]);
  const physical = join(state.directory, 'evidence', root);
  await assert.rejects(verifyRunnerFailureDiagnostics(report, physical), /source location differs/);
  assert.equal((await verifyRunnerFailureDiagnostics(report, physical, { recordedDirectory: `/retained/runner-matrix/${root}` })).casesPerEngine, 15);
  for (const path of ['/retained/runner-matrix/pair-00-flashwright/../elsewhere', 'relative/path', '/retained/runner-matrix/%2e%2e']) {
    await assert.rejects(verifyRunnerFailureDiagnostics(report, physical, { recordedDirectory: path }), /normalized absolute path/);
  }
  report.runner.suites[0].specs.find(specification => specification.title.startsWith('failure/')).tests[0].results[0].attachments[0].path = '/outside/error-context.md';
  await assert.rejects(verifyRunnerFailureDiagnostics(report, physical, { recordedDirectory: `/retained/runner-matrix/${root}` }), /within test-output/);
}));

test('snapshot custody rejects mutation, omitted launch and extra artifact before semantic admission', { timeout: 60000 }, () => withFixture(async state => {
  const path = join(state.directory, 'evidence', 'pair-00-flashwright', 'stderr.txt');
  await writeFile(path, 'changed');
  try { await assert.rejects(verifyRunnerMatrixSnapshot(state.directory), /custody changed/); }
  finally { await writeFile(path, state.files['pair-00-flashwright/stderr.txt']); }
  const run = join(state.directory, 'evidence', 'pair-07-flashwright');
  await rename(run, `${run}-removed`);
  try { await assert.rejects(verifyRunnerMatrixSnapshot(state.directory), /custody changed/); }
  finally { await rename(`${run}-removed`, run); }
  await writeFile(join(state.directory, 'private-probe.txt'), 'extra');
  try { await assert.rejects(verifyRunnerMatrixSnapshot(state.directory), /custody changed/); }
  finally { await rm(join(state.directory, 'private-probe.txt')); }
}));

test('rewriting a custody hash cannot admit changed predicate meaning', { timeout: 60000 }, () => withFixture(async state => {
  const root = 'pair-00-flashwright';
  const path = Object.keys(state.files).find(path => path.startsWith(`${root}/test-output/`) && path.endsWith('/error-context.md'));
  const changed = Buffer.from(state.files[path].toString().replace('Received: no matching element', 'Received: no observation before the deadline'));
  const files = { ...state.files, [path]: changed };
  const admission = JSON.parse(files[`${root}/admission.json`]);
  admission.files[path.slice(root.length + 1)] = hash(changed);
  const title = path.includes('warmup') ? 'failure/warmup/0' : 'failure/sample/0';
  admission.diagnosticAdmission.cases[title].documentSha256 = hash(changed);
  files[`${root}/admission.json`] = serialize(admission);
  await writeFile(join(state.directory, 'evidence', path), changed);
  try { await assert.rejects(verifyPortableRunnerEvidence(files, join(state.directory, 'evidence'), configuration, policy), /missing retained predicate evidence/); }
  finally { await writeFile(join(state.directory, 'evidence', path), state.files[path]); }
}));

test('retained inventory refuses symlinks and an unplanned attempted directory', { timeout: 60000 }, () => withFixture(async state => {
  const path = join(state.directory, 'evidence', 'pair-00-flashwright', 'stderr.txt');
  await rename(path, `${path}-original`);
  await symlink(`${path}-original`, path);
  try { await assert.rejects(runnerMatrixEvidenceFiles(join(state.directory, 'evidence')), /Symlink/); }
  finally { await rm(path); await rename(`${path}-original`, path); }
  const extra = join(state.directory, 'evidence', 'pair-08-flashwright');
  await mkdir(extra);
  try { await assert.rejects(runnerMatrixEvidenceFiles(join(state.directory, 'evidence')), /unplanned attempted launch/); }
  finally { await rm(extra, { recursive: true }); }
}));

test('original numeric custody rejects a changed observation even when the public byte manifest is rebuilt', { timeout: 60000 }, () => withFixture(async state => {
  const path = 'evidence/pair-00-flashwright/resources.json';
  const original = state.files['pair-00-flashwright/resources.json'];
  const resources = JSON.parse(original);
  resources.observedCpuSeconds += 1;
  const changed = serialize(resources);
  const manifest = structuredClone(state.manifest);
  manifest.exportedFiles[path] = hash(changed);
  await writeFile(join(state.directory, path), changed);
  await writeFile(join(state.directory, 'manifest.json'), serialize(manifest));
  try { await assert.rejects(verifyRunnerMatrixSnapshot(state.directory), /Original numeric evidence changed/); }
  finally {
    await writeFile(join(state.directory, path), original);
    await writeFile(join(state.directory, 'manifest.json'), serialize(state.manifest));
  }
}));

test('snapshot refuses an unexpected empty directory and a directory replacing a regular collector file', { timeout: 60000 }, () => withFixture(async state => {
  const extra = join(state.directory, 'empty-private-probe');
  await mkdir(extra);
  try { await assert.rejects(verifyRunnerMatrixSnapshot(state.directory), /empty retained directory/); }
  finally { await rm(extra, { recursive: true }); }
  const path = join(state.directory, 'evidence', 'pair-00-flashwright', 'stderr.txt');
  await rename(path, `${path}-original`);
  await mkdir(path);
  try { await assert.rejects(verifyRunnerMatrixSnapshot(state.directory), /empty retained directory/); }
  finally { await rm(path, { recursive: true }); await rename(`${path}-original`, path); }
}));

test('public reader rejects log-only extra attempts and orphan verifier logs instead of silently dropping them', { timeout: 60000 }, () => withFixture(async state => {
  const evidenceDirectory = join(state.directory, 'evidence');
  for (const name of ['pair-08-flashwright.txt', 'pair-08-flashwright-verification.txt', 'pair-00-playwright-verification.txt']) {
    await writeFile(join(evidenceDirectory, name), 'synthetic attempt log');
    try { await assert.rejects(runnerMatrixEvidenceFiles(evidenceDirectory), /Unplanned log-only attempted launch|Orphan attempted-launch verifier log/); }
    finally { await rm(join(evidenceDirectory, name)); }
  }
}));
