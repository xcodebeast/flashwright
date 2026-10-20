import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { finalGoalAccountingClasses } from '../benchmarks/final-goal-resource-policy.mjs';
import { runnerFamilies, runnerFamilyTitles, verifyRunnerFamilyOutcomes } from '../benchmarks/runner-family-contract.mjs';
import { runnerSpecifications } from '../benchmarks/runner-suite-contract.mjs';
import { verifyRunnerFailureDiagnosticBytes } from '../benchmarks/runner-suite-diagnostics.mjs';
import { launchArguments } from '../benchmarks/paired-contract.mjs';
import { reconstructFinalGoalLinuxCapturedOutputs, reconstructFinalGoalLinuxResourceEvidence } from './final-goal-linux-evidence.mjs';
import { decodeLinuxApplicationJson as decodeJson } from './final-goal-linux-json.mjs';

export const linuxFamilyEvidenceLimits = Object.freeze({ maximumFileBytes: 4 * 1024 ** 2,
  maximumAggregateInputBytes: 16 * 1024 ** 2, maximumDocumentBytes: 256 * 1024 });
const names = ['adapter.mjs', 'runner.config.mjs', 'suite-configuration.json', 'workloads.spec.mjs'];
const outputNames = ['owner-report.json', 'runner-report.json', 'runner-stdout.txt', 'runner-stderr.txt', 'diagnostic-documents.json'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const absolute = path => typeof path === 'string' && path.length > 0 && path.length <= 4096
  && !/[\0\\%]/.test(path) && posix.isAbsolute(path) && posix.normalize(path) === path;
const relative = path => typeof path === 'string' && path.length > 0 && path.length <= 4096
  && !/[\0\\]/.test(path) && !posix.isAbsolute(path) && posix.normalize(path) === path
  && !path.split('/').some(part => ['', '.', '..'].includes(part));

function validateManifest(manifest, resourceManifest, outputManifest) {
  assert.deepEqual(Object.keys(manifest ?? {}).sort(), ['accountingClass', 'captureSha256', 'generated', 'prepared', 'schemaVersion']);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.accountingClass, finalGoalAccountingClasses.linux);
  assert.match(manifest.captureSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(manifest.captureSha256, resourceManifest.files?.capture?.sha256, 'Family manifest borrows another capture');
  assert.equal(manifest.captureSha256, outputManifest.captureSha256);
  assert.deepEqual(Object.keys(resourceManifest.files ?? {}).sort(), ['after', 'before', 'capture', 'native']);
  assert(Array.isArray(manifest.generated) && manifest.generated.length === 4, 'Expected four generated family inputs');
  assert(Array.isArray(outputManifest.outputs) && outputManifest.outputs.length === 5, 'Expected five captured family outputs');
  // Bound structured output decoding before the output loader fetches any bytes.
  for (const index of [0, 1, 4]) assert(Number.isSafeInteger(outputManifest.outputs[index]?.bytes)
    && outputManifest.outputs[index].bytes > 0 && outputManifest.outputs[index].bytes <= linuxFamilyEvidenceLimits.maximumFileBytes,
  'Family structured output byte limit exceeded');
  const paths = new Set([...Object.values(resourceManifest.files), ...outputManifest.outputs].map(r => r.path));
  const originals = new Set(); let total = 0;
  for (const receipt of [manifest.prepared, ...manifest.generated]) {
    assert.deepEqual(Object.keys(receipt ?? {}).sort(), ['bytes', 'originalPath', 'path', 'sha256']);
    assert(relative(receipt.path) && !paths.has(receipt.path), 'Family retained path must be unique and contained');
    assert(absolute(receipt.originalPath) && !originals.has(receipt.originalPath), 'Invalid or reused family original path');
    assert(Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0
      && receipt.bytes <= linuxFamilyEvidenceLimits.maximumFileBytes, 'Family input byte limit exceeded');
    assert.match(receipt.sha256 ?? '', /^[a-f0-9]{64}$/);
    paths.add(receipt.path); originals.add(receipt.originalPath); total += receipt.bytes;
  }
  assert(total <= linuxFamilyEvidenceLimits.maximumAggregateInputBytes, 'Family input aggregate limit exceeded');
}
function time(value) {
  assert(typeof value === 'string' && /^(0|[1-9][0-9]{0,29})$/.test(value), 'Invalid owner timestamp');
  return BigInt(value);
}

/** Reconstruct this pinned Bun runner profile from captured bytes, never historical filesystem paths. */
export async function reconstructFinalGoalLinuxFamily({ resourceManifest, outputManifest, manifest, readBytes, family, engine, workers }) {
  assert(runnerFamilies.includes(family));
  assert(['playwright', 'flashwright'].includes(engine) && [1, 4].includes(workers));
  validateManifest(manifest, resourceManifest, outputManifest);
  const retained = new Map();
  const needed = new Set([resourceManifest.files.capture.path, resourceManifest.files.before.path,
    ...[0, 1, 4].map(index => outputManifest.outputs[index].path)]);
  const reader = async (receipt, limits) => {
    const bytes = await readBytes(receipt, limits);
    if (needed.has(receipt.path)) retained.set(receipt.path, bytes);
    return bytes;
  };
  const outputs = await reconstructFinalGoalLinuxCapturedOutputs(resourceManifest, outputManifest, reader);
  const resources = await reconstructFinalGoalLinuxResourceEvidence(resourceManifest, reader);
  // These large records have already passed the strict original-resource parser.
  const original = key => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(retained.get(resourceManifest.files[key].path)));
  const capture = original('capture'), before = original('before');
  assert(Array.isArray(before.inputs.files) && before.inputs.files.length <= 65536, 'Captured input inventory limit exceeded');
  const inputs = new Map();
  for (const receipt of before.inputs.files) {
    assert(absolute(receipt.path) && !inputs.has(receipt.path), 'Duplicate or invalid captured input path');
    inputs.set(receipt.path, receipt);
  }
  const hasCapturedSource = path => {
    assert(absolute(path), 'Invalid original source path');
    const aliases = before.inputs.files.filter(receipt => receipt.path === path || receipt.resolvedPath === path);
    assert(aliases.length > 0, 'Original source is not captured');
    for (const receipt of aliases) {
      assert.match(receipt.sha256 ?? '', /^[a-f0-9]{64}$/);
      assert(Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0);
      assert.equal(receipt.sha256, aliases[0].sha256, 'Captured source aliases disagree');
      assert.equal(receipt.bytes, aliases[0].bytes, 'Captured source aliases disagree');
    }
  };
  for (const receipt of [manifest.prepared, ...manifest.generated]) {
    const captured = inputs.get(receipt.originalPath);
    assert(captured && captured.sha256 === receipt.sha256 && captured.bytes === receipt.bytes, 'Family input differs from original capture');
  }
  const readInput = async receipt => {
    const bytes = await readBytes(receipt, { maximumFileBytes: linuxFamilyEvidenceLimits.maximumFileBytes, expectedSize: receipt.bytes });
    assert(Buffer.isBuffer(bytes) && bytes.length === receipt.bytes && hash(bytes) === receipt.sha256, 'Retained family input bytes changed');
    return bytes;
  };
  const prepared = decodeJson(await readInput(manifest.prepared));
  assert.equal(prepared.schemaVersion, 1);
  assert.equal(prepared.family, family); assert.equal(prepared.engine, engine); assert.equal(prepared.workers, workers);
  assert(absolute(prepared.workspaceDirectory) && absolute(prepared.directory));
  assert.equal(prepared.project, posix.join(prepared.directory, 'project'));
  assert.equal(manifest.prepared.originalPath, posix.join(prepared.directory, 'prepared.json'));
  assert.deepEqual(prepared.expectedTitles, runnerFamilyTitles(family));
  assert.deepEqual(prepared.ownerCommand, capture.workloadCommand);
  assert.equal(prepared.ownerCommand.length, 3);
  assert.equal(prepared.ownerCommand[0], before.inputs.executables.runtime.path);
  assert.equal(prepared.ownerCommand[2], prepared.directory);
  hasCapturedSource(prepared.ownerCommand[1]);
  assert.equal(prepared.browser.executablePath, before.inputs.executables.browser.path);
  assert.equal(prepared.browser.sha256, before.inputs.executables.browser.sha256);
  assert.equal(prepared.driverPath, before.inputs.executables.driver.path);

  const baselineBytes = await readFile(new URL('../benchmarks/configurations/runner-suite.json', import.meta.url));
  const sourceBytes = await readFile(new URL('../benchmarks/runner-suite/workloads.spec.mjs', import.meta.url));
  const configuration = decodeJson(baselineBytes); configuration.workloads = [family]; configuration.workers = workers;
  assert.equal(prepared.originalConfigurationSha256, hash(baselineBytes));
  assert.equal(prepared.originalWorkloadSha256, hash(sourceBytes));
  assert.deepEqual(prepared.configuration, configuration, 'Selected family configuration changed');
  assert.equal(prepared.browser.version, configuration.browserVersion);
  const runnerConfiguration = { testDir: '.', testMatch: 'workloads.spec.mjs', workers, fullyParallel: workers === 4,
    retries: 0, repeatEach: 1, maxFailures: 0, forbidOnly: true, timeout: 30000, expect: { timeout: 5000 },
    outputDir: posix.join(prepared.directory, 'test-output'), reporter: [['json', { outputFile: posix.join(prepared.directory, 'runner-report.json') }]],
    use: { headless: true, viewport: configuration.viewport, trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 5000, navigationTimeout: 10000 } };
  assert.deepEqual(prepared.runnerConfiguration, runnerConfiguration);
  // Exact pinned dependency layout; no require.resolve or imports from a historical workspace.
  const workspace = prepared.workspaceDirectory, native = engine === 'flashwright';
  const entry = posix.join(workspace, native ? 'packages/flashwright-test/dist/commonjs/index.js'
    : 'node_modules/.bun/@playwright+test@1.60.0/node_modules/@playwright/test/index.js');
  const cli = posix.join(workspace, native ? 'packages/flashwright-test/cli.cjs'
    : 'node_modules/.bun/playwright@1.60.0/node_modules/playwright/cli.js');
  const guard = posix.join(workspace, 'benchmarks/native-backend-guard.mjs');
  for (const path of [entry, cli, ...(native ? [guard] : [])]) hasCapturedSource(path);
  assert.deepEqual(prepared.runnerCommand, [prepared.ownerCommand[0], cli, 'test', '--config', posix.join(prepared.project, 'runner.config.mjs')]);
  const guardSource = native ? `import { forbidUpstreamBrowserBackend } from ${JSON.stringify(pathToFileURL(guard).href)};\nforbidUpstreamBrowserBackend();\n` : '';
  const expectedSources = {
    'adapter.mjs': Buffer.from(`${guardSource}export { test, expect, defineConfig } from ${JSON.stringify(pathToFileURL(entry).href)};\nexport const nativeBackendGuardActive = ${native};\n`),
    'runner.config.mjs': Buffer.from(`import { defineConfig } from './adapter.mjs';\nconst configuration = ${JSON.stringify(runnerConfiguration)};\nconfiguration.use.baseURL = process.env.FLASHWRIGHT_TEST_BASE_URL;\nconfiguration.use.launchOptions = { executablePath: process.env.FLASHWRIGHT_BROWSER_PATH };\nexport default defineConfig(configuration);\n`),
    'suite-configuration.json': Buffer.from(JSON.stringify({ configuration, launchIndex: 0 }) + '\n'),
    'workloads.spec.mjs': sourceBytes,
  };
  assert.deepEqual(Object.keys(prepared.generatedFiles).sort(), names);
  assert.deepEqual(manifest.generated.map(r => r.originalPath).sort(), names.map(name => posix.join(prepared.project, name)).sort(), 'Incomplete generated family input inventory');
  for (const receipt of manifest.generated) {
    const name = posix.relative(prepared.project, receipt.originalPath);
    assert.equal(receipt.sha256, prepared.generatedFiles[name]);
    assert.deepEqual(await readInput(receipt), expectedSources[name], `Executed ${name} differs from original policy`);
  }
  assert.deepEqual(outputs.outputs.map(r => r.originalPath), outputNames.map(name => posix.join(prepared.directory, name)), 'Unexpected family output roles or order');
  const owner = decodeJson(retained.get(outputManifest.outputs[0].path));
  const runner = decodeJson(retained.get(outputManifest.outputs[1].path));
  assert.equal(resources.wrapperExitCode, 0, 'Family owner must complete even for intentional test failures');
  assert.equal(owner.serviceClosed, true);
  assert.deepEqual(owner.runnerCommand, prepared.runnerCommand);
  assert.equal(owner.clock.captureIdentity, resources.captureIdentity);
  assert.equal(owner.clock.domain, 'linux-clock-monotonic');
  assert.equal(owner.clock.originNanoseconds, resources.workloadClock.originNanoseconds);
  assert.equal(owner.clock.implementation, resources.clock);
  assert.deepEqual(owner.events.map(e => e.name), ['fixture-start-requested', 'fixture-listening', 'runner-spawn-requested',
    'runner-closed', 'runner-streams-retained', 'reporter-output-readable', 'fixture-close-requested', 'fixture-closed', 'owner-report-write-requested']);
  let previous = time(resources.commandInterval.startedNanoseconds);
  const finished = time(resources.commandInterval.finishedNanoseconds);
  for (const event of owner.events) {
    const now = time(event.nanoseconds); assert(now >= previous && now <= finished, 'Owner event escapes original capture interval'); previous = now;
  }
  const runtime = { name: 'bun', version: '1.4.2' };
  const outcome = verifyRunnerFamilyOutcomes({ family, engine, workers, configuration, runner, owner, runtime });
  const specs = runnerSpecifications(runner.suites), lines = sourceBytes.toString('utf8').split('\n');
  const declaration = lines.findIndex(line => line.includes('test(`${workload}/${phase}/${iteration}`'));
  assert(declaration >= 0);
  for (const spec of specs) {
    assert.equal(spec.line, declaration + 1); assert.equal(spec.column, lines[declaration].indexOf('test('));
  }
  const marker = native ? 'flashwright:browser <launching> ' : 'pw:browser <launching> ';
  const stderr = specs.map(s => s.tests[0].results[0].stderr.map(e => e.text ?? Buffer.from(e.buffer, 'base64').toString()).join('')).join('\n');
  const launches = stripVTControlCharacters(stderr).split('\n').filter(line => line.includes(marker));
  assert.equal(launches.length, outcome.reportedWorkerProcesses);
  const policy = decodeJson(await readFile(new URL('../crates/flashwright-browser/src/chromium-launch-policy.json', import.meta.url)));
  for (const line of launches) assert.deepEqual(launchArguments(line, engine, prepared.browser.executablePath), policy.headless);

  const documents = decodeJson(retained.get(outputManifest.outputs[4].path));
  assert.deepEqual(Object.keys(documents), ['artifacts']);
  assert(Array.isArray(documents.artifacts) && documents.artifacts.length === outcome.actualFailures);
  const attachments = specs.flatMap(s => s.tests[0].results[0].attachments);
  assert.deepEqual(documents.artifacts.map(a => a.path), attachments.map(a => a.path), 'Diagnostic bundle differs from original attachment inventory');
  const diagnosticBytes = new Map([[posix.join(prepared.project, 'workloads.spec.mjs'), sourceBytes]]);
  for (const artifact of documents.artifacts) {
    assert.deepEqual(Object.keys(artifact).sort(), ['bytes', 'path']);
    assert(absolute(artifact.path) && !diagnosticBytes.has(artifact.path), 'Reused or invalid diagnostic path');
    assert(typeof artifact.bytes === 'string' && artifact.bytes.length <= 4 * Math.ceil(linuxFamilyEvidenceLimits.maximumDocumentBytes / 3), 'Diagnostic document byte limit exceeded');
    const bytes = Buffer.from(artifact.bytes, 'base64');
    assert(bytes.length > 0 && bytes.length <= linuxFamilyEvidenceLimits.maximumDocumentBytes && bytes.toString('base64') === artifact.bytes, 'Invalid diagnostic base64 encoding');
    diagnosticBytes.set(artifact.path, bytes);
  }
  let diagnosticContent;
  if (family === 'failure') diagnosticContent = await verifyRunnerFailureDiagnosticBytes({ engine, configuration, launchIndex: 0, runtime, runner },
    prepared.directory, async path => {
      assert(diagnosticBytes.has(path), 'Missing captured diagnostic bytes'); return diagnosticBytes.get(path);
    });
  return { schemaVersion: 1, ...outcome, status: 'verified-retained-linux-family-outcomes', accountingClass: finalGoalAccountingClasses.linux,
    captureIdentity: resources.captureIdentity, captureSha256: manifest.captureSha256,
    executedConfigurationVerified: true, adapterBytesVerified: true, originalWorkloadBytesUnchanged: true,
    reportedBrowserLaunches: launches.length, diagnosticContentVerified: family === 'failure', ...(diagnosticContent ? { diagnosticContent } : {}),
    observedDrainedMembership: resources.observedDrainedMembership, nativeCleanObservedTeardown: resources.nativeCleanObservedTeardown,
    scope: 'Pinned Bun family inputs, reported outcomes/launch policy and captured failure documents within original resource/owner intervals. Source hashes do not attest callback execution, loaded code, native context/process custody or final resource/performance admission.' };
}
