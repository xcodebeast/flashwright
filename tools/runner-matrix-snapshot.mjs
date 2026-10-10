import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { hash } from './competitor-inputs.mjs';
import { numericApplicationObservations } from './application-snapshot.mjs';
import { verifyRunnerSuite, renderRunnerSuiteAdmission } from '../benchmarks/runner-suite-contract.mjs';
import { verifyRunnerFailureDiagnostics } from '../benchmarks/runner-suite-diagnostics.mjs';
import { analyzeRunnerMatrix, renderRunnerMatrixReport } from '../benchmarks/runner-matrix-contract.mjs';

const canonicalDirectory = '/retained/runner-matrix';
const engines = ['playwright', 'flashwright'];
const topLevelEvidence = ['plan.json', 'source-preflight.json', 'machine.json', 'environmental-confound.json', 'first-pair-admission.json'];
const generatedInputs = ['project/workloads.spec.mjs', 'project/adapter.mjs', 'project/runner.config.mjs', 'project/suite-configuration.json', 'launch-inputs.json'];
const runFiles = ['inputs.json', 'launch-inputs.json', 'admission.json', 'sample.json', 'runner-report.json', 'resources.json', 'stdout.txt', 'stderr.txt', 'table.md', ...generatedInputs.filter(path => path !== 'launch-inputs.json'), 'test-output/.last-run.json'];
const privatePath = /\/(?:Users|home)\/|\/(?:private\/)?(?:var|tmp)\//;
const serialize = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const hashes = files => Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => [path, hash(bytes)]));
const decode = bytes => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert.ok(!text.includes('\0'), 'Binary evidence is unsupported');
  return text;
};
const parse = (files, path) => { assert.ok(files[path], `Missing retained file: ${path}`); return JSON.parse(decode(files[path])); };
const pairName = (index, engine) => `pair-${String(index).padStart(2, '0')}-${engine}`;
const contained = path => {
  assert.ok(typeof path === 'string' && path && !isAbsolute(path) && normalize(path) === path && !path.split(/[\\/]/).some(component => ['', '.', '..'].includes(component)) && !path.includes('%'), `Invalid retained path: ${path}`);
  return path;
};
const nested = (parent, child) => { const suffix = relative(parent, child); return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix)); };
const declaredRedactions = [{ file: 'environmental-confound.json', field: 'creationOperation', replacement: 'private-worktree-creation', reason: 'Private desktop worktree operation identity; original file byte hash retained.' }];

/** Bound every read, including logs, and refuse links, special files and files changing during the read. */
async function retainedBytes(directory, path) {
  contained(path);
  let current = directory;
  const root = await lstat(current);
  assert.ok(root.isDirectory() && !root.isSymbolicLink(), 'Evidence root must be an ordinary directory');
  const components = path.split('/');
  let information;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    information = await lstat(current);
    assert.ok(!information.isSymbolicLink(), `Symlink in retained custody: ${path}`);
    assert.ok(index === components.length - 1 ? information.isFile() : information.isDirectory(), `Unexpected retained file type: ${path}`);
  }
  assert.ok(information.size <= 32 * 1024 * 1024, `Oversized retained file: ${path}`);
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const status = await file.stat();
    assert.ok(status.isFile() && status.dev === information.dev && status.ino === information.ino && status.size === information.size, 'Evidence changed before read');
    const bytes = Buffer.alloc(status.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    assert.equal(length, status.size, 'Evidence changed during read');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

async function inventory(directory, prefix = '') {
  const root = await lstat(join(directory, prefix));
  assert.ok(root.isDirectory() && !root.isSymbolicLink(), 'Evidence directory must be ordinary');
  const files = {};
  for (const name of (await readdir(join(directory, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    contained(path);
    const information = await lstat(join(directory, path));
    assert.ok(!information.isSymbolicLink(), `Symlink in evidence: ${path}`);
    if (information.isDirectory()) {
      const children = await inventory(directory, path);
      assert.ok(Object.keys(children).length, `Unexpected empty retained directory: ${path}`);
      Object.assign(files, children);
    }
    else files[path] = await retainedBytes(directory, path);
  }
  return files;
}

/** Select the public collector's exact evidence, excluding private probes and orchestration scripts. */
export async function runnerMatrixEvidenceFiles(directory) {
  const files = {};
  for (const path of topLevelEvidence) files[path] = await retainedBytes(directory, path);
  const plan = parse(files, 'plan.json');
  assert.equal(plan.independentPairs, 8, 'The declared matrix requires all eight independent pairs');
  assert.deepEqual(plan.engines, engines);
  const expectedRuns = Array.from({ length: plan.independentPairs }, (_, index) => engines.map(engine => pairName(index, engine))).flat();
  const attemptedRuns = [];
  const names = await readdir(directory);
  for (const name of names) {
    if (!/^pair-/.test(name)) continue;
    const information = await lstat(join(directory, name));
    assert.ok(!information.isSymbolicLink(), 'Symlink in attempted run custody');
    if (information.isDirectory()) attemptedRuns.push(name);
    else {
      assert.ok(information.isFile(), 'Attempted-launch logs must be ordinary files');
      assert.match(name, /^pair-\d{2}-(?:playwright|flashwright)(?:-verification)?\.txt$/, 'Unreviewed attempted-launch artifact');
      const stem = name.replace(/(?:-verification)?\.txt$/, '');
      assert.ok(expectedRuns.includes(stem), `Unplanned log-only attempted launch: ${name}`);
      if (name.endsWith('-verification.txt')) assert.ok(names.includes(`${stem}.txt`), `Orphan attempted-launch verifier log: ${name}`);
    }
  }
  assert.deepEqual(attemptedRuns.sort(), expectedRuns.sort(), 'Missing or unplanned attempted launch; never silently drop an attempt');
  for (const root of expectedRuns) {
    const run = await inventory(join(directory, root));
    const report = parse(run, 'sample.json');
    const expectedDocuments = [['warmup', report.configuration.warmupIterations], ['sample', report.configuration.measuredIterations]]
      .flatMap(([phase, count]) => Array.from({ length: count }, (_, index) => `test-output/workloads-failure-${phase}-${index}/error-context.md`));
    assert.deepEqual(Object.keys(run).sort(), [...runFiles, ...expectedDocuments].sort(), `Unreviewed or missing public collector artifact: ${root}`);
    for (const [path, bytes] of Object.entries(run)) files[`${root}/${path}`] = bytes;
  }
  return files;
}

/** Replace only exact approved roots and their URLs, with path boundaries on both sides. */
export function normalizeRunnerMatrixEvidence(files, mappings) {
  const replacements = [];
  const originals = new Set();
  for (const { original, replacement, relativePath = false } of mappings) {
    assert.ok(typeof original === 'string' && original && !originals.has(original), 'Duplicate or missing normalization root');
    originals.add(original);
    if (relativePath) assert.ok(/^(?:\.\.\/)+/.test(original) && !original.endsWith('/'), 'Relative mapping must be the known recorded cwd relation');
    else {
      assert.ok(isAbsolute(original) && resolve(original) === original && original.split('/').filter(Boolean).length >= 2, 'Mapping requires a specific normalized absolute path');
      assert.ok(!/^\/(?:Users|home)\/[^/]+$/.test(original) && !/^\/(?:private\/)?var\/folders\/[^/]+(?:\/[^/]+(?:\/T)?)?$/.test(original) && !['/tmp', '/var', '/private/var', '/Users', '/home'].includes(original), 'Mapping root is too broad');
      replacements.push([pathToFileURL(original).href, pathToFileURL(replacement).href]);
    }
    assert.match(replacement, /^\/(?:workspace|retained\/runner-matrix|runtime\/executable|browser\/executable|driver\/executable|environment\/browser-profile-\d+)(?:\/|$)/);
    replacements.push([original, replacement]);
  }
  replacements.sort(([left], [right]) => right.length - left.length);
  const output = {};
  for (const [path, bytes] of Object.entries(files)) {
    contained(path);
    assert.match(path, /\.(?:json|txt|md|mjs)$/);
    let text = decode(bytes);
    for (const [original, replacement] of replacements) text = text.replaceAll(original, (match, offset, whole) => {
      const before = whole[offset - 1];
      const after = whole[offset + match.length];
      const followsCursorControl = /(?:\x1b|\\u001[bB])\[[0-?]*[ -/]*[@-~]$/.test(whole.slice(0, offset));
      const leftBoundary = before === undefined || /[\s"'(<>=:]/.test(before) || followsCursorControl;
      const rightBoundary = after === undefined || /[\/\s"'<>),\]:\\]/.test(after);
      return leftBoundary && rightBoundary ? replacement : match;
    });
    // Inspect all escape spellings as well, so an encoded workstation path cannot bypass publication checks.
    const inspected = text.replace(/%([a-f0-9]{2})/gi, (_, value) => String.fromCharCode(Number.parseInt(value, 16)));
    assert.ok(!privatePath.test(text) && !privatePath.test(inspected), `Unmapped private path in ${path}`);
    assert.ok(!/(?:file:\/\/|\/(?:Users|home|private|var|tmp|workspace|retained|browser|runtime|driver|environment)\/)[^\s"'<>]*%[a-f0-9]{2}/i.test(text), `Unreviewed percent-escaped path in ${path}`);
    assert.ok(!/(?:\.\.\/)+(?:Users|home|p\/|\.codex\/)/.test(inspected), `Unmapped private relative path in ${path}`);
    output[path] = Buffer.from(text);
  }
  return output;
}

function automaticMappings(files, source, workspace) {
  const mappings = [{ original: source, replacement: canonicalDirectory }, { original: workspace, replacement: '/workspace' }];
  const cwdRelation = relative(workspace, source);
  if (cwdRelation.startsWith('../')) mappings.push({ original: cwdRelation, replacement: canonicalDirectory, relativePath: true });
  const add = (original, replacement) => {
    const previous = mappings.find(mapping => mapping.original === original);
    if (previous) assert.equal(previous.replacement, replacement, 'Conflicting normalization identity');
    else mappings.push({ original, replacement });
  };
  const profiles = new Set();
  for (const root of runRoots(files)) {
    const inputs = parse(files, `${root}/inputs.json`);
    add(inputs.browser.executablePath, '/browser/executable');
    add(inputs.runtime.executable, '/runtime/executable');
    add(inputs.driverPath, '/driver/executable');
    const report = parse(files, `${root}/sample.json`);
    const marker = report.engine === 'playwright' ? 'pw:browser <launching> ' : 'flashwright:browser <launching> ';
    for (const line of stripVTControlCharacters(report.runnerStderr).split('\n').filter(line => line.includes(marker))) {
      const command = line.slice(line.indexOf(marker) + marker.length);
      const arguments_ = report.engine === 'flashwright' ? JSON.parse(command).arguments : command.slice(inputs.browser.executablePath.length + 1).split(' ');
      const flags = arguments_.filter(argument => argument.startsWith('--user-data-dir='));
      assert.equal(flags.length, 1, 'Controlled launch must have one profile');
      const profile = flags[0].slice('--user-data-dir='.length);
      assert.match(profile, /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/(?:playwright_chromiumdev_profile|flashwright-chromium)-[A-Za-z0-9_-]+$/, 'Only controlled individual browser profiles may normalize');
      profiles.add(profile);
    }
  }
  [...profiles].sort().forEach((profile, index) => add(profile, `/environment/browser-profile-${index}`));
  return mappings;
}

const runRoots = files => Object.keys(files).filter(path => /^pair-\d{2}-(?:playwright|flashwright)\/inputs\.json$/.test(path)).map(path => dirname(path)).sort();
const runEvidence = (files, root) => Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith(`${root}/`)).map(([path, bytes]) => [path.slice(root.length + 1), bytes]));

/** Rebuild only artifact hash edges affected by path normalization; identities and observations stay fixed. */
export function rebuildRunnerMatrixEvidence(files, originals) {
  for (const root of runRoots(files)) {
    const inputs = parse(files, `${root}/inputs.json`);
    for (const path of generatedInputs) inputs.generatedFiles[path] = hash(files[`${root}/${path}`]);
    files[`${root}/inputs.json`] = serialize(inputs);
    const admission = parse(files, `${root}/admission.json`);
    for (const [title, diagnostic] of Object.entries(admission.diagnosticAdmission.cases)) {
      const path = `test-output/workloads-${title.replaceAll('/', '-')}/error-context.md`;
      diagnostic.documentSha256 = hash(files[`${root}/${path}`]);
    }
    admission.files = hashes(Object.fromEntries(Object.entries(runEvidence(files, root)).filter(([path]) => path !== 'admission.json')));
    files[`${root}/admission.json`] = serialize(admission);
  }
  for (const [path, bytes] of Object.entries(originals)) {
    if (!path.endsWith('.json')) continue;
    const before = JSON.parse(decode(bytes));
    const after = parse(files, path);
    assert.deepEqual(numericApplicationObservations(after), numericApplicationObservations(before), `Numeric observation changed: ${path}`);
    for (const key of ['sources', 'dependencies', 'driverSha256']) if (before[key] !== undefined) assert.deepEqual(after[key], before[key], `Historical identity changed: ${path}/${key}`);
    if (before.browser) for (const key of ['sha256', 'version', 'versionOutput', 'distribution']) assert.deepEqual(after.browser[key], before.browser[key]);
    if (before.runtime?.sha256) assert.equal(after.runtime.sha256, before.runtime.sha256);
  }
  return files;
}

function verifyGeneratedBody(files, root, inputs, launch) {
  assert.deepEqual(Object.keys(inputs.generatedFiles).sort(), [...generatedInputs].sort());
  for (const path of generatedInputs) assert.equal(inputs.generatedFiles[contained(path)], hash(files[`${root}/${path}`]), `Generated input changed: ${root}/${path}`);
  assert.equal(inputs.generatedFiles['project/workloads.spec.mjs'], inputs.sources['benchmarks/runner-suite/workloads.spec.mjs'], 'Common controlled test body changed');
  const configuration = `import { defineConfig } from './adapter.mjs';\nconst configuration = ${JSON.stringify(inputs.runnerConfiguration)};\nconfiguration.use.baseURL = process.env.FLASHWRIGHT_TEST_BASE_URL;\nexport default defineConfig(configuration);\n`;
  assert.equal(decode(files[`${root}/project/runner.config.mjs`]), configuration, 'Generated runner configuration body changed');
  const adapter = decode(files[`${root}/project/adapter.mjs`]);
  const guard = launch.engine === 'flashwright' ? 'import { forbidUpstreamBrowserBackend } from "file:///workspace/benchmarks/native-backend-guard.mjs";\nforbidUpstreamBrowserBackend();\n' : '';
  const exportLine = adapter.slice(guard.length).match(/^export \{ test, expect, defineConfig \} from ("[^"]+");\nexport const nativeBackendGuardActive = (true|false);\n$/);
  assert.ok(adapter.startsWith(guard) && exportLine, 'Generated adapter body changed');
  assert.equal(exportLine[2], String(launch.engine === 'flashwright'));
  const entry = JSON.parse(exportLine[1]);
  const dependencyPath = fileURLToPath(entry);
  assert.ok(dependencyPath.startsWith('/workspace/'), 'Adapter must name retained dependency identity');
  const path = dependencyPath.slice('/workspace/'.length);
  contained(path);
  if (launch.engine === 'flashwright') {
    assert.equal(path, 'packages/flashwright-test/dist/esm/index.js');
    assert.ok(inputs.sources['packages/flashwright-test/package.json'], 'Missing runner source identity');
    assert.ok(Object.keys(inputs.dependencies).some(name => name.endsWith('@flashwright/test/package.json')), 'Missing runner dependency identity');
  } else {
    assert.match(path, /^node_modules\/(?:\.bun\/@playwright\+test@1\.60\.0\/node_modules\/)?@playwright\/test\/index\.mjs$/);
    assert.ok(inputs.dependencies[path], 'Reference adapter entry must bind its exact dependency manifest path');
  }
}

/** Recompute the original suite decisions from retained bytes without accessing historical executables. */
export async function verifyPortableRunnerEvidence(files, physicalDirectory, configuration, policy) {
  const preflight = parse(files, 'source-preflight.json');
  assert.equal(preflight.status, 'verified-engine-with-reviewed-harness-delta');
  assert.equal(preflight.originalCoreGroups, 179);
  assert.match(preflight.coreReportSha256, /^[a-f0-9]{64}$/);
  const plan = parse(files, 'plan.json');
  const machine = parse(files, 'machine.json');
  assert.equal(machine.schemaVersion, 1);
  assert.equal(machine.platform, 'darwin');
  assert.equal(machine.architecture, 'arm64');
  assert.ok(typeof machine.cpu === 'string' && machine.cpu);
  assert.ok(typeof machine.operatingSystem === 'string' && machine.operatingSystem);
  assert.ok(Number.isInteger(machine.logicalProcessors) && machine.logicalProcessors > 0);
  assert.ok(Number.isInteger(machine.totalMemoryBytes) && machine.totalMemoryBytes > 0);
  assert.ok(Number.isFinite(Date.parse(machine.recordedAt)));
  assert.equal(machine.headless, configuration.headless);
  assert.equal(machine.workers, configuration.workers);
  assert.equal(machine.scope, 'Stable machine identity recorded during collection; no initial-load or exclusive-host claim.');
  assert.equal(plan.independentPairs, configuration.independentLaunches);
  assert.equal(plan.expectedFailureTimeoutMilliseconds, configuration.expectedFailureTimeoutMilliseconds);
  assert.match(preflight.sourceCommit, /^[0-9a-f]{40}$/);
  assert.ok(preflight.sourceCommit.startsWith(plan.sourceCommitPrefix), 'Preflight source commit differs from plan');
  const pairs = [];
  for (let index = 0; index < configuration.independentLaunches; index++) {
    const runs = {};
    for (const engine of engines) {
      const root = pairName(index, engine);
      const run = runEvidence(files, root);
      const inputs = parse(run, 'inputs.json');
      const launch = parse(run, 'launch-inputs.json');
      const report = parse(run, 'sample.json');
      const resources = parse(run, 'resources.json');
      const admission = parse(run, 'admission.json');
      const recordedDirectory = `${canonicalDirectory}/${root}`;
      assert.deepEqual(inputs.sources, preflight.sources, 'Historical preflight source map differs from measured inputs');
      assert.equal(inputs.driverSha256, preflight.driverSha256);
      for (const [key, value] of Object.entries(preflight.browser)) assert.deepEqual(inputs.browser[key], value);
      assert.equal(admission.status, 'passed-runner-outcomes');
      assert.equal(admission.inputsUnchanged, true);
      assert.deepEqual(admission.exit, { code: 0, signal: null });
      assert.deepEqual(admission.files, hashes(Object.fromEntries(Object.entries(run).filter(([path]) => path !== 'admission.json'))), 'Run receipt inventory or bytes mismatch');
      assert.deepEqual(report, JSON.parse(decode(run['stdout.txt'])), 'Sample differs from original collector stdout');
      assert.deepEqual(report.runner, parse(run, 'runner-report.json'));
      assert.equal(report.engine, engine);
      assert.equal(report.launchIndex, index);
      assert.deepEqual(report.runtime, machine.runtime);
      assert.deepEqual(report.browser, inputs.browser);
      assert.deepEqual(launch.browser, inputs.browser);
      assert.equal(report.driverSha256, inputs.driverSha256);
      assert.equal(launch.driverSha256, inputs.driverSha256);
      assert.equal(inputs.driverPath, '/driver/executable');
      assert.equal(inputs.runtime.executable, '/runtime/executable');
      assert.equal(inputs.browser.executablePath, '/browser/executable');
      assert.equal(launch.driverPath, inputs.driverPath);
      assert.equal(launch.engine, engine);
      assert.equal(launch.launchIndex, index);
      assert.deepEqual(launch.configuration, configuration);
      assert.deepEqual(resources.command, [inputs.runtime.executable, 'benchmarks/runner-suite-sample.mjs', recordedDirectory]);
      assert.deepEqual(launch.runnerCommand.slice(1), ['test', '--config', `${recordedDirectory}/project/runner.config.mjs`]);
      assert.ok(launch.runnerCommand[0].startsWith('/workspace/'));
      assert.ok(launch.runnerCommand[0].endsWith(engine === 'playwright' ? '/playwright/cli.js' : '/packages/flashwright-test/cli.cjs'));
      assert.equal(report.runner.config.configFile, launch.runnerCommand[3]);
      assert.equal(inputs.runnerConfiguration.outputDir, `${recordedDirectory}/test-output`);
      assert.deepEqual(inputs.runnerConfiguration.reporter, [['json', { outputFile: `${recordedDirectory}/runner-report.json` }]]);
      assert.deepEqual(inputs.runnerConfiguration.use, { headless: true, viewport: configuration.viewport, launchOptions: { executablePath: inputs.browser.executablePath }, trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 5000, navigationTimeout: 10000 });
      assert.deepEqual(inputs.runnerConfiguration, { testDir: '.', testMatch: 'workloads.spec.mjs', workers: 1, retries: 0, repeatEach: 1, fullyParallel: false,
        maxFailures: 0, forbidOnly: true, timeout: 30000, expect: { timeout: 5000 }, outputDir: `${recordedDirectory}/test-output`,
        reporter: [['json', { outputFile: `${recordedDirectory}/runner-report.json` }]], use: inputs.runnerConfiguration.use });
      assert.deepEqual(parse(run, 'project/suite-configuration.json'), { configuration, launchIndex: index });
      verifyGeneratedBody(files, root, inputs, launch);
      const decision = { ...verifyRunnerSuite(report, resources, configuration, policy), diagnosticAdmission: await verifyRunnerFailureDiagnostics(report, join(physicalDirectory, root), { recordedDirectory }) };
      for (const [key, value] of Object.entries(decision)) assert.deepEqual(admission[key], value, `Changed runner decision: ${root}/${key}`);
      assert.equal(decode(run['table.md']), renderRunnerSuiteAdmission(report, decision));
      runs[engine] = { report, admission, resources, inputs };
    }
    pairs.push({ launchIndex: index, order: index % 2 ? ['flashwright', 'playwright'] : engines, runs });
  }
  assert.equal(runRoots(files).length, configuration.independentLaunches * engines.length, 'Unplanned retained launch');
  const firstPair = parse(files, 'first-pair-admission.json');
  assert.equal(firstPair.status, 'passed-first-pair-content-admission');
  assert.equal(firstPair.pair, 0);
  assert.deepEqual(firstPair.independentVerifierExitCodes, [0, 0]);
  assert.equal(firstPair.originalFailureDocumentsPerEngine, configuration.warmupIterations + configuration.measuredIterations);
  assert.deepEqual(firstPair.matchingFields, ['sourceSha256', 'snapshotSha256', 'normalizedSourceFrameSha256', 'callSite', 'retainedPredicateObservation']);
  for (const [title, reference] of Object.entries(pairs[0].runs.playwright.admission.diagnosticAdmission.cases)) {
    for (const field of firstPair.matchingFields) assert.deepEqual(pairs[0].runs.flashwright.admission.diagnosticAdmission.cases[title][field], reference[field], `First-pair content admission changed: ${field}`);
  }
  const environmentalConfounds = [parse(files, 'environmental-confound.json')];
  assert.equal(environmentalConfounds[0].performanceAccepted, false);
  return analyzeRunnerMatrix({ configuration, pairs, environmentalConfounds });
}

function observationHashes(files) {
  return Object.fromEntries(Object.entries(files).filter(([path]) => path.endsWith('.json')).map(([path, bytes]) => [path, hash(serialize(numericApplicationObservations(JSON.parse(decode(bytes)))))]));
}

const snapshotFiles = ['configuration.json', 'chromium-launch-policy.json', 'matrix-result.json', 'table.md', 'commands.json'];

/** Verify independently using only the public snapshot and committed semantic admission code. */
export async function verifyRunnerMatrixSnapshot(directory) {
  const all = await inventory(resolve(directory));
  const manifest = parse(all, 'manifest.json');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'portable-runner-matrix');
  assert.equal(manifest.originalVerification, 'recorded-source-checkout-with-live-identities');
  assert.equal(manifest.portableVerification, 'independent-retained-custody-and-semantic-admission');
  assert.equal(manifest.liveExecutableBytesVerified, false);
  assert.equal(manifest.installedDependencyBytesVerified, false);
  assert.equal(manifest.sourceIdentitiesPreserved, true);
  assert.equal(manifest.numericObservationsPreserved, true);
  assert.deepEqual(manifest.redactions, declaredRedactions);
  const exported = Object.fromEntries(Object.entries(all).filter(([path]) => path !== 'manifest.json'));
  assert.deepEqual(hashes(exported), manifest.exportedFiles, 'Snapshot inventory or byte custody changed');
  const files = Object.fromEntries(Object.entries(exported).filter(([path]) => path.startsWith('evidence/')).map(([path, bytes]) => [path.slice('evidence/'.length), bytes]));
  assert.deepEqual(Object.keys(all).sort(), ['manifest.json', ...snapshotFiles, ...Object.keys(files).map(path => `evidence/${path}`)].sort(), 'Unexpected snapshot artifact');
  assert.deepEqual(Object.keys(files).sort(), Object.keys(manifest.originalFiles).sort(), 'Snapshot omitted original public collector evidence');
  for (const digest of Object.values(manifest.originalFiles)) assert.match(digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(observationHashes(files), manifest.originalNumericObservationHashes, 'Original numeric evidence changed');
  assert.deepEqual(normalizeRunnerMatrixEvidence(exported, []), exported, 'Snapshot path normalization is incomplete');
  assert.deepEqual(await runnerMatrixEvidenceFiles(join(resolve(directory), 'evidence')), files, 'Unexpected retained collector files');
  const configuration = parse(all, 'configuration.json');
  const policy = parse(all, 'chromium-launch-policy.json');
  const preflight = parse(files, 'source-preflight.json');
  assert.equal(hash(all['configuration.json']), preflight.sources['benchmarks/configurations/runner-suite.json']);
  assert.equal(hash(all['chromium-launch-policy.json']), preflight.sources['crates/flashwright-browser/src/chromium-launch-policy.json']);
  assert.equal(manifest.sourceCommit, preflight.sourceCommit);
  assert.deepEqual(manifest.recordedSources, preflight.sources);
  assert.equal(parse(files, 'environmental-confound.json').creationOperation, 'private-worktree-creation');
  assert.deepEqual(manifest.coreReceiptReference, { sha256: preflight.coreReportSha256, groups: preflight.originalCoreGroups, sourceCommit: preflight.originalCoreSourceCommit, rerun: false });
  const analysis = await verifyPortableRunnerEvidence(files, join(resolve(directory), 'evidence'), configuration, policy);
  assert.deepEqual(parse(all, 'matrix-result.json'), analysis, 'Matrix decisions or observations changed');
  assert.equal(decode(all['table.md']), renderRunnerMatrixReport(analysis), 'Matrix table changed');
  assert.equal(analysis.performanceAccepted, false, 'Retained environmental confound forbids performance acceptance');
  const commands = parse(all, 'commands.json');
  assert.equal(commands.measuredSourceCommit, preflight.sourceCommit);
  assert.equal(commands.recordedVerifierSha256, preflight.sources['tools/verify-runner-suite.mjs']);
  assert.deepEqual(commands.recordedVerification, ['/runtime/exporter', '/workspace/tools/verify-runner-suite.mjs', '/retained/runner-matrix/PAIR']);
  assert.deepEqual(commands.exportToolSources, manifest.exportToolSources);
  return { manifest, analysis };
}

/** Verify each frozen raw run before normalization, retain every measured byte hash, and publish atomically. */
export async function exportRunnerMatrix({ sourceDirectory, destination, recordedWorkspace }) {
  const source = await realpath(sourceDirectory);
  const workspace = await realpath(recordedWorkspace);
  assert.equal(resolve(sourceDirectory), source, 'Raw evidence root must not resolve through an alias');
  assert.equal(resolve(recordedWorkspace), workspace, 'Recorded workspace must not resolve through an alias');
  const target = resolve(destination);
  assert.ok(!nested(source, target) && !nested(target, source), 'Destination must be separate from raw evidence');
  let existingParent = dirname(target);
  while (true) {
    const information = await lstat(existingParent).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (information) {
      assert.ok(information.isDirectory() && !information.isSymbolicLink(), 'Destination parent must be an ordinary directory');
      assert.equal(await realpath(existingParent), existingParent, 'Destination ancestors must not resolve through an alias');
      break;
    }
    existingParent = dirname(existingParent);
  }
  await mkdir(dirname(target), { recursive: true });
  const targetParent = await realpath(dirname(target));
  assert.equal(targetParent, dirname(target), 'Destination parent must not resolve through an alias');
  assert.equal(await lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false, 'Destination already exists');
  const originals = await runnerMatrixEvidenceFiles(source);
  const originalFiles = hashes(originals);
  const preflight = parse(originals, 'source-preflight.json');
  assert.equal(preflight.status, 'verified-engine-with-reviewed-harness-delta');
  assert.equal(preflight.originalCoreGroups, 179);
  assert.match(preflight.coreReportSha256, /^[a-f0-9]{64}$/);
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8', stdio: 'pipe' }).trim();
  assert.equal(sourceCommit, preflight.sourceCommit, 'Recorded checkout commit differs from historical preflight');
  assert.equal(hash(await retainedBytes(workspace, 'tools/verify-runner-suite.mjs')), preflight.sources['tools/verify-runner-suite.mjs'], 'Recorded verifier source differs from historical preflight');
  for (const root of runRoots(originals)) {
    execFileSync(process.execPath, [join(workspace, 'tools/verify-runner-suite.mjs'), join(source, root)], { cwd: workspace, stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
  }
  assert.deepEqual(hashes(await runnerMatrixEvidenceFiles(source)), originalFiles, 'Raw evidence changed during recorded verification');
  const configurationBytes = await retainedBytes(workspace, 'benchmarks/configurations/runner-suite.json');
  const policyBytes = await retainedBytes(workspace, 'crates/flashwright-browser/src/chromium-launch-policy.json');
  assert.equal(hash(configurationBytes), preflight.sources['benchmarks/configurations/runner-suite.json']);
  assert.equal(hash(policyBytes), preflight.sources['crates/flashwright-browser/src/chromium-launch-policy.json']);
  const files = rebuildRunnerMatrixEvidence(normalizeRunnerMatrixEvidence(originals, automaticMappings(originals, source, workspace)), originals);
  const confound = parse(files, 'environmental-confound.json');
  assert.match(confound.creationOperation, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i, 'Expected the explicit private worktree operation identity');
  confound.creationOperation = 'private-worktree-creation';
  files['environmental-confound.json'] = serialize(confound);
  const staging = `${target}.export-${process.pid}`;
  await mkdir(staging);
  try {
    const exported = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [`evidence/${path}`, bytes]));
    exported['configuration.json'] = configurationBytes;
    exported['chromium-launch-policy.json'] = policyBytes;
    for (const [path, bytes] of Object.entries(exported)) {
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await writeFile(join(staging, path), bytes, { flag: 'wx' });
    }
    const analysis = await verifyPortableRunnerEvidence(files, join(staging, 'evidence'), JSON.parse(decode(configurationBytes)), JSON.parse(decode(policyBytes)));
    exported['matrix-result.json'] = serialize(analysis);
    exported['table.md'] = Buffer.from(renderRunnerMatrixReport(analysis));
    const toolDirectory = dirname(fileURLToPath(import.meta.url));
    const toolPaths = ['tools/runner-matrix-snapshot.mjs', 'tools/export-runner-matrix.mjs', 'tools/verify-runner-matrix-snapshot.mjs', 'benchmarks/runner-matrix-contract.mjs', 'benchmarks/runner-suite-diagnostics.mjs'];
    const exportToolSources = Object.fromEntries(await Promise.all(toolPaths.map(async path => [path, hash(await readFile(join(toolDirectory, '..', path)))])));
    exported['commands.json'] = serialize({ measuredSourceCommit: preflight.sourceCommit, recordedVerifierSha256: preflight.sources['tools/verify-runner-suite.mjs'], exportToolSources,
      recordedVerification: ['/runtime/exporter', '/workspace/tools/verify-runner-suite.mjs', '/retained/runner-matrix/PAIR'],
      exportRuntime: { name: process.versions.bun ? 'bun' : 'node', version: process.versions.bun ?? process.versions.node },
      export: ['bun', 'tools/export-runner-matrix.mjs', 'RAW', 'NEW_DESTINATION', 'RECORDED_WORKSPACE'], portableVerification: ['bun', 'tools/verify-runner-matrix-snapshot.mjs', 'SNAPSHOT'],
      scope: 'Raw admission verifies the frozen recorded checkout, installed dependency bytes and executable identities. Portable verification checks retained custody and original semantic decisions; it does not freshly validate installed dependencies or executables. The referenced 179-group core receipt is historical and was not rerun.' });
    const manifest = { schemaVersion: 1, kind: 'portable-runner-matrix', originalVerification: 'recorded-source-checkout-with-live-identities', portableVerification: 'independent-retained-custody-and-semantic-admission',
      liveExecutableBytesVerified: false, installedDependencyBytesVerified: false, sourceIdentitiesPreserved: true, numericObservationsPreserved: true,
      originalFiles, originalNumericObservationHashes: observationHashes(originals), exportedFiles: hashes(exported), recordedSources: preflight.sources, sourceCommit: preflight.sourceCommit, exportToolSources, redactions: declaredRedactions,
      coreReceiptReference: { sha256: preflight.coreReportSha256, groups: preflight.originalCoreGroups, sourceCommit: preflight.originalCoreSourceCommit, rerun: false } };
    for (const path of ['matrix-result.json', 'table.md', 'commands.json']) await writeFile(join(staging, path), exported[path], { flag: 'wx' });
    await writeFile(join(staging, 'manifest.json'), serialize(manifest), { flag: 'wx' });
    await verifyRunnerMatrixSnapshot(staging);
    assert.deepEqual(hashes(await runnerMatrixEvidenceFiles(source)), originalFiles, 'Raw evidence changed during export');
    await rename(staging, target);
    return { manifest, analysis };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
