import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createBackendCorpusPackedConfigurationData, renderBackendCorpusPackedConfiguration,
  analyzeBackendCorpusPackedReport } from './backend-corpus-packed.mjs';
import { createBackendCorpusCandidateConfigurationData } from './backend-corpus-candidate.mjs';
import { createBackendCorpusReferenceConfigurationData } from './backend-corpus-reference.mjs';
import { backendCorpusInventory } from './backend-corpus-common.mjs';

const options = { frontendDirectory: '/fixture/frontend', outputDirectory: '/fixture/output',
  jsonReportPath: '/fixture/report.json', browserExecutablePath: '/fixture/chrome',
  backendURL: 'http://127.0.0.1:32109', workers: 4 };
const browserMethods = ['launch', 'launchPersistentContext', 'connect', 'connectOverCDP'];
const upstreamSource = `const browser = () => Object.fromEntries(${JSON.stringify(browserMethods)}.map(method => [method, async () => 'unmodified-browser']));
module.exports = { chromium: browser(), firefox: browser(), webkit: browser(), request: { newContext: async () => 'unmodified-request' } };`;

async function writePackage(directory, name, source) {
  const packageDirectory = join(directory, 'node_modules', name);
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'index.cjs' }));
  await writeFile(join(packageDirectory, 'index.cjs'), source);
  return packageDirectory;
}

/** Load emitted source in a separate Bun process, with real resolution and no installed product code. */
async function loadConfiguration({ workers = 4, missing, replacement, wrongDirectory = false,
  driverOverride, ancestorPackages = false, escapingLinks = false, internalLinks = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'flashwright-packed-config-')));
  try {
    const frontendDirectory = join(directory, 'frontend');
    await mkdir(frontendDirectory);
    await writeFile(join(frontendDirectory, 'package.json'), '{}');
    const packageOwner = ancestorPackages || escapingLinks ? directory : frontendDirectory;
    const canonicalDirectory = await writePackage(packageOwner, '@flashwright/test', `
const events = [];
module.exports = { events, test() {}, request: { newContext() {} }, chromium: { launch() {} },
  devices: { 'Desktop Chrome': { userAgent: 'fixture-installed-agent', viewport: { width: 900, height: 600 } } },
  defineConfig(configuration) { events.push('defineConfig'); return configuration; } };
${missing ? `delete module.exports[${JSON.stringify(missing)}];` : ''}`);
    await writePackage(packageOwner, '@playwright/test', `
const canonical = require('@flashwright/test');
module.exports = ${replacement ? `{ ...canonical, ${replacement}: ${replacement === 'test' ? 'function differentTest() {}' : replacement === 'request' ? '{ newContext() {} }' : '{ launch() {} }'} }` : 'canonical'};`);
    const runnerDirectory = await writePackage(packageOwner, '@flashwright/runner', 'module.exports = {};');
    const upstreamPath = join(runnerDirectory, 'dist', 'upstream', 'test.js');
    await mkdir(join(runnerDirectory, 'dist', 'upstream'), { recursive: true });
    await writeFile(upstreamPath, upstreamSource);
    for (const name of ['@playwright/test', '@flashwright/test', '@flashwright/runner']) {
      const original = join(packageOwner, 'node_modules', name);
      const consumerLink = join(frontendDirectory, 'node_modules', name);
      if (escapingLinks) {
        await mkdir(dirname(consumerLink), { recursive: true });
        await symlink(original, consumerLink);
      } else if (internalLinks) {
        const stored = join(frontendDirectory, 'node_modules', '.store', name.replace('/', '-'));
        await mkdir(dirname(stored), { recursive: true });
        await rename(original, stored);
        await symlink(relative(dirname(consumerLink), stored), consumerLink);
      }
    }
    const unrelatedPath = join(directory, 'unrelated-upstream.cjs');
    await writeFile(unrelatedPath, upstreamSource);
    const parameters = { ...options, workers, frontendDirectory };
    const configurationPath = join(frontendDirectory, 'packed.config.mjs');
    await writeFile(configurationPath, renderBackendCorpusPackedConfiguration(parameters));
    const probePath = join(directory, 'probe.mjs');
    await writeFile(probePath, `import { createRequire } from 'node:module';
const requireFixture = createRequire(import.meta.url);
const canonical = requireFixture(${JSON.stringify(join(canonicalDirectory, 'index.cjs'))});
const upstream = requireFixture(${JSON.stringify(upstreamPath)});
const unrelated = requireFixture(${JSON.stringify(unrelatedPath)});
let configuration, error;
try { configuration = (await import(${JSON.stringify(pathToFileURL(configurationPath).href)})).default; }
catch (failure) { error = failure.message; }
const guarded = [];
for (const browser of ['chromium', 'firefox', 'webkit']) {
  for (const method of ${JSON.stringify(browserMethods)}) {
    try { guarded.push(await upstream[browser][method]()); }
    catch (failure) { guarded.push(failure.message); }
  }
}
try { guarded.push(await upstream.request.newContext()); }
catch (failure) { guarded.push(failure.message); }
process.stdout.write(JSON.stringify({ configuration, error, events: canonical.events, guarded,
  unrelatedBrowser: await unrelated.chromium.launch(), unrelatedRequest: await unrelated.request.newContext() }));`);
    const environment = { ...process.env };
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'FLASHWRIGHT_DRIVER_PATH']) delete environment[name];
    if (driverOverride !== undefined) environment.FLASHWRIGHT_DRIVER_PATH = driverOverride;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [probePath], {
      cwd: wrongDirectory ? directory : frontendDirectory, env: environment,
      timeout: 5000, maxBuffer: 131072, killSignal: 'SIGKILL',
    });
    assert.equal(stderr, '');
    return { observed: JSON.parse(stdout), parameters };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function assertRejectedBeforeGuard(observed, expected) {
  assert.match(observed.error ?? '', expected);
  assert.equal(observed.configuration, undefined);
  assert.deepEqual(observed.events, []);
  assert.deepEqual(observed.guarded, [...Array(12).fill('unmodified-browser'), 'unmodified-request']);
}

test('emitted packed configuration loads local aliases, guards its upstream instance and keeps common policy', async () => {
  for (const workers of [1, 4]) {
    const { observed, parameters } = await loadConfiguration({ workers });
    assert.equal(observed.error, undefined);
    assert.deepEqual(observed.events, ['defineConfig']);
    assert.deepEqual(observed.guarded, [...Array(12).fill('Forbidden upstream browser backend entered'), 'Forbidden upstream request backend entered']);
    assert.equal(observed.unrelatedBrowser, 'unmodified-browser');
    assert.equal(observed.unrelatedRequest, 'unmodified-request');
    const { metadata, ...policy } = observed.configuration;
    const { metadata: referenceMetadata, ...referencePolicy } = createBackendCorpusReferenceConfigurationData(parameters);
    referencePolicy.projects[1].use.userAgent = 'fixture-installed-agent';
    assert.deepEqual(policy, referencePolicy);
    assert.deepEqual(metadata, createBackendCorpusPackedConfigurationData(parameters).metadata);
    assert.equal(metadata.backendCorpusPacked.executionClass, 'packed-alias-functional-admission');
    assert.equal(metadata.backendCorpusCandidate, undefined);
    assert.equal(metadata.backendCorpusReference, undefined);
    assert.equal(metadata.backendCorpusPacked.candidateWorkspace, undefined);
    assert.equal(referenceMetadata.backendCorpusReference.playwrightVersion, '1.60.0');
  }
});

test('emitted packed configuration rejects every missing or mismatched canonical export before guard installation', async () => {
  for (const name of ['test', 'request', 'chromium']) {
    assertRejectedBeforeGuard((await loadConfiguration({ missing: name })).observed, new RegExp(`missing a usable ${name}`));
    assertRejectedBeforeGuard((await loadConfiguration({ replacement: name })).observed, new RegExp(`${name} identity differs`));
  }
});

test('emitted packed configuration rejects foreign cwd and host driver override before guard installation', async () => {
  assertRejectedBeforeGuard((await loadConfiguration({ wrongDirectory: true })).observed, /from its frontend directory/);
  assertRejectedBeforeGuard((await loadConfiguration({ driverOverride: '/fixture/host-driver' })).observed, /host driver override/);
});

test('emitted packed configuration rejects packages resolved from an ancestor rather than its consumer', async () => {
  assertRejectedBeforeGuard((await loadConfiguration({ ancestorPackages: true })).observed, /consumer|installed|outside/i);
});

test('emitted packed configuration accepts internal package links and rejects links escaping its consumer', async () => {
  const internal = await loadConfiguration({ internalLinks: true });
  assert.equal(internal.observed.error, undefined);
  assert.deepEqual(internal.observed.events, ['defineConfig']);
  assert.deepEqual(internal.observed.guarded, [...Array(12).fill('Forbidden upstream browser backend entered'), 'Forbidden upstream request backend entered']);
  assertRejectedBeforeGuard((await loadConfiguration({ escapingLinks: true })).observed, /consumer|installed|outside/i);
});

/** Synthetic identities exercise metadata admission only, never browser or application success. */
function reportFixture(configuration) {
  let identifier = 0;
  return { config: { rootDir: options.frontendDirectory, workers: options.workers, metadata: configuration.metadata,
    projects: configuration.projects.map(project => ({ name: project.name, testDir: configuration.testDir,
      outputDir: configuration.outputDir, retries: 0, repeatEach: 1 })) },
    suites: backendCorpusInventory.files.map(file => ({ title: file.path, specs: file.declarations.map(declaration => ({
      id: `packed-fixture-${identifier++}`, title: declaration.title, file: file.path.slice('frontend/'.length), line: declaration.line,
      tests: [{ projectName: file.projectName, status: 'expected', expectedStatus: 'passed',
        results: [{ status: 'passed', retry: 0, duration: 1, workerIndex: 0, startTime: '2026-01-01T00:00:00.000Z' }] }],
    })) })), errors: [], stats: { expected: 62, unexpected: 0, skipped: 0, flaky: 0 } };
}

test('packed report distinguishes development and reference metadata while retaining original report objects', () => {
  const packed = reportFixture(createBackendCorpusPackedConfigurationData(options));
  const analysis = analyzeBackendCorpusPackedReport(packed, options);
  assert.equal(analysis.structureMatchesCorpus, true);
  assert.strictEqual(analysis.rawReport, packed);
  assert.equal(analysis.executionClass, 'packed-alias-functional-admission');
  assert.match(analysis.scope, /does not establish comparative performance or release acceptance/);
  for (const configuration of [createBackendCorpusReferenceConfigurationData(options),
    createBackendCorpusCandidateConfigurationData({ ...options, candidateWorkspace: '/fixture/workspace' })]) {
    const report = reportFixture(configuration);
    const rejected = analyzeBackendCorpusPackedReport(report, options);
    assert.equal(rejected.inventory.complete, true);
    assert.equal(rejected.structureMatchesCorpus, false);
    assert.equal(rejected.allTestsPassed, false);
    assert.strictEqual(rejected.rawReport, report);
    assert.ok(rejected.configurationIssues.some(issue => issue.startsWith('Declared packed metadata differs')));
  }
});
