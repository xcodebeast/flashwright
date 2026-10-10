import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { sourceManifest } from './source-manifest.mjs';
import { hash } from './competitor-inputs.mjs';
import { readEngineConfiguration } from './engine-configuration.mjs';
import { broadEngines, broadLaunchOrder, normalizeBroadLaunch, renderBroadMatrixTable, summarizeBroadMatrix } from '../benchmarks/broad-matrix-contract.mjs';
import { verifyPuppeteerSample, verifyWebdriverSample } from '../benchmarks/competitor-contract.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const configuration = read('benchmarks/configurations/baseline.json');
const contenders = read('benchmarks/configurations/competitors.json');
const policies = {
  chromium: read('crates/flashwright-browser/src/chromium-launch-policy.json'),
  webdriverio: read('benchmarks/configurations/webdriverio-launch-policy.json'),
  cypress: read('benchmarks/configurations/cypress-launch-policy.json'),
};

// Retained historical runs exercise real report formats; they are not new matrix measurements.
function fixture(engine) {
  if (engine === 'playwright' || engine === 'flashwright') {
    const directory = 'benchmarks/results/current-paired-2026-10-10';
    const report = read(`${directory}/launch-0-${engine}.json`);
    // Historical paired reports predate this telemetry. These additions are synthetic test data.
    for (const workload of report.workloads.filter(workload => workload.name !== 'setup')) Object.assign(workload.observations,
      { viewport: configuration.viewport, focused: true, visibilityState: 'visible' });
    return { engine, launchIndex: 0, report, resources: read(`${directory}/resources-0-${engine}.json`),
      configuration, contenders, policies, browserPath: read(`${directory}/metadata.json`).browser.executablePath };
  }
  const directory = engine === 'puppeteer' ? 'benchmarks/results/competitor-admission-2026-10-10/node22-full'
    : engine === 'webdriverio' ? 'benchmarks/results/webdriverio-admission-2026-10-10/webdriverio-node22-full'
      : 'benchmarks/results/cypress-admission-2026-10-10/node22';
  return { engine, launchIndex: 0, report: read(`${directory}/sample.json`), receipt: read(`${directory}/admission.json`),
    resources: read(`${directory}/resources.json`), configuration, contenders, policies };
}

function samplingFixture(engine, launchIndex = 0) {
  const state = fixture(engine);
  state.admission = fixture(engine);
  state.launchIndex = launchIndex;
  state.report.sampling = { launchIndex, reportPersistence: 'after-completion', isolationProbe: 'separate-admission', protocolLogging: engine === 'webdriverio' ? 'warning' : 'off' };
  state.report.isolation = null;
  state.report.backend.documents -= 2;
  const offset = launchIndex % configuration.workloads.length;
  state.report.workloads = state.report.workloads.slice(offset).concat(state.report.workloads.slice(0, offset));
  if (engine === 'webdriverio') state.report.browserProcessId = state.resources.processes[0].process;
  const verify = engine === 'puppeteer' ? verifyPuppeteerSample : verifyWebdriverSample;
  Object.assign(state.receipt, verify(state.report, state.resources, configuration, contenders, policies.chromium, policies.webdriverio), { status: 'passed-sampling-outcomes' });
  return state;
}

for (const engine of ['puppeteer', 'webdriverio']) {
  test(`${engine} sampling requires matching separate admission and retains native differences`, () => {
    const state = samplingFixture(engine, 3);
    const result = normalizeBroadLaunch(state);
    assert.equal(result.equivalentReferenceWork, false);
    assert.ok(result.semanticDifferences.some(difference => difference.workload === 'backend'));
    assert.deepEqual(result.instrumentation, engine === 'webdriverio' ? ['Startup process-command observation'] : []);
  });
  for (const [name, mutate] of [
    ['missing admission', state => { delete state.admission; }],
    ['failed isolation', state => { state.admission.report.isolation.cookies = 'leaked=value'; }],
    ['changed admission receipt', state => { state.admission.receipt.functionalAdmissionPassed = false; }],
    ['different admitted browser', state => { state.admission.report.browser.sha256 = 'different'; }],
    ['different admitted package bytes', state => { state.admission.report.package.manifestSha256 = 'different'; }],
    ['wrong sample launch index', state => { state.launchIndex++; }],
  ]) test(`${engine} sampling matrix rejects ${name}`, () => {
    const state = samplingFixture(engine, 3); mutate(state);
    assert.throws(() => normalizeBroadLaunch(state));
  });
}

for (const engine of broadEngines) test(`normalizes the ${engine} fixture and uses measured child wall time`, () => {
  const state = fixture(engine);
  const result = normalizeBroadLaunch(state);
  assert.equal(result.processWallMilliseconds, state.resources.elapsedSeconds * 1000);
  assert.equal(result.workloads.backend.length, configuration.measuredIterations);
  assert.equal(result.equivalentReferenceWork, engine === 'flashwright' || engine === 'playwright');
});

test('new broad observations require viewport and focus telemetry from both reference and candidate', () => {
  for (const engine of ['flashwright', 'playwright']) {
    const state = fixture(engine);
    delete state.report.workloads.find(workload => workload.name !== 'setup').observations.viewport;
    assert.throws(() => normalizeBroadLaunch(state));
  }
});

test('raw semantic corruption is rejected even when admission still says passed', () => {
  const state = fixture('puppeteer');
  state.report.backend.backendRequests--;
  assert.equal(state.receipt.functionalAdmissionPassed, true);
  assert.throws(() => normalizeBroadLaunch(state));
});

test('WebdriverIO launch-policy and diagnostic instrumentation remain visible', () => {
  const state = fixture('webdriverio');
  const result = normalizeBroadLaunch(state);
  assert.ok(result.semanticDifferences.some(difference => difference.reason === state.receipt.launchPolicyDifference));
  assert.ok(result.instrumentation.includes('Verbose ChromeDriver protocol logging'));
});

for (const [name, mutate] of [
  ['a duplicate iteration', state => { state.report.workloads[0].samples[1].iteration = 0; }],
  ['a lost warmup', state => { state.report.workloads[0].warmupSamples.pop(); }],
  ['an incomplete preparation-inclusive total', state => { state.report.workloads[0].completeMilliseconds = 0; }],
  ['a changed decision', state => { state.receipt.differences = []; }],
  ['watchdog cleanup', state => { state.resources.cleanupSignals.push({ process: 1, signal: 'SIGTERM' }); }],
  ['missing elapsed time', state => { delete state.resources.elapsedSeconds; }],
]) test(`rejects ${name}`, () => {
  const state = fixture('puppeteer'); mutate(state);
  assert.throws(() => normalizeBroadLaunch(state));
});

test('Cypress intentional failures remain runner failures and its startup is not invented', () => {
  const state = fixture('cypress');
  const result = normalizeBroadLaunch(state);
  assert.equal(result.expectedFailures, 15);
  assert.equal(result.startupMilliseconds, null);
  assert.equal(result.workloadTotals, null);
  state.report.result.totalFailed = 0;
  assert.throws(() => normalizeBroadLaunch(state));
});

test('all engines run once per group and reference/candidate order alternates', () => {
  for (let index = 0; index < configuration.independentLaunches; index++) {
    const order = broadLaunchOrder(index);
    assert.deepEqual([...order].sort(), [...broadEngines].sort());
    assert.equal(order.indexOf('playwright') < order.indexOf('flashwright'), index % 2 === 0);
  }
});

function illustrativeLaunches() {
  return Object.fromEntries(broadEngines.map(engine => [engine, Array.from({ length: configuration.independentLaunches }, (_, launchIndex) => ({
    ...normalizeBroadLaunch(fixture(engine)), launchIndex,
  }))]));
}

test('matrix refuses missing contenders, dropped launches and duplicate launch identities', () => {
  for (const mutate of [launches => { delete launches.cypress; }, launches => { launches.flashwright.pop(); }, launches => { launches.puppeteer[1].launchIndex = 0; }]) {
    const launches = illustrativeLaunches(); mutate(launches);
    assert.throws(() => summarizeBroadMatrix(launches, configuration, contenders));
  }
});

test('table includes all workload groups, uncertainty, failure counts and comparison limits', () => {
  const summary = summarizeBroadMatrix(illustrativeLaunches(), configuration, contenders);
  const table = renderBroadMatrixTable(summary);
  assert.equal(summary.performanceLeadershipEstablished, false);
  for (const engine of broadEngines) for (const workload of configuration.workloads) assert.ok(table.includes(`| ${engine} | ${workload} |`));
  assert.match(table, /95% launch-clustered intervals/);
  assert.match(table, /120 expected, 0 unexpected/);
  assert.match(table, /Verbose ChromeDriver protocol logging/);
  assert.match(table, /No broad performance ranking/);
  assert.equal(summary.rows.find(row => row.engine === 'puppeteer').workloads.noop.p95, null);
});

for (const sampleLibrary of [false, true]) test(`independent verifier recomputes a synthetic full ${sampleLibrary ? 'sampling' : 'diagnostic'} snapshot and rejects altered evidence`, { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flashwright-matrix-verifier-test-'));
  const write = async (path, value) => {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  };
  try {
    const sources = await sourceManifest();
    const previous = read('benchmarks/results/current-paired-2026-10-10/metadata.json');
    const runtime = { name: 'node', version: '22.22.0', executable: '/synthetic/node', sha256: hash('synthetic runtime') };
    const coreLog = 'Synthetic verifier fixture only. No browser or benchmark was executed.\n';
    const core = { status: 'passed', sourceChangedDuringVerification: false, browserChangedDuringVerification: false,
      sources, driverSha256: hash('synthetic driver'), browser: previous.browser, runtime: { name: runtime.name, version: runtime.version },
      platform: 'synthetic', architecture: 'synthetic', engineConfiguration: readEngineConfiguration(), checks: [{ code: 0, log: 'synthetic.log', logSha256: hash(coreLog) }] };
    await write('verification/report.json', core);
    await write('verification/synthetic.log', coreLog);
    const metadata = { syntheticTestFixture: true, plan: { engines: broadEngines, sampleLibrary }, configuration, contenders, policies, sources,
      browser: previous.browser, measuredRuntime: runtime, platform: core.platform, architecture: core.architecture,
      engineConfiguration: core.engineConfiguration, driverSha256: core.driverSha256,
      verificationSha256: hash(await readFile(join(directory, 'verification/report.json'))), competitorDependencies: {} };
    const launches = Object.fromEntries(broadEngines.map(engine => [engine, []]));
    const attempts = [];
    async function writeCompetitor(state, root) {
      const { engine } = state;
      const originalDirectory = engine === 'puppeteer' ? 'benchmarks/results/competitor-admission-2026-10-10/node22-full'
        : engine === 'webdriverio' ? 'benchmarks/results/webdriverio-admission-2026-10-10/webdriverio-node22-full'
          : 'benchmarks/results/cypress-admission-2026-10-10/node22';
      const inputs = read(`${originalDirectory}/inputs.json`);
      const originalSources = inputs.sources ?? inputs.inputs;
      for (const file of Object.keys(originalSources)) originalSources[file] = sources[file];
      inputs.runtime = { executable: runtime.executable, sha256: runtime.sha256 };
      metadata.competitorDependencies[engine] = inputs.installedDependencies;
      if (engine === 'webdriverio') metadata.chromeDriverSha256 = inputs.driverSha256;
      if (engine === 'cypress') metadata.cypressBundleFiles = inputs.bundle;
      state.resources.command = [runtime.executable, `benchmarks/${engine}-admission.mjs`, join(directory, root, 'sample.json')];
      if (state.report.sampling) {
        state.resources.command.push(String(state.launchIndex));
        await write(`${root}/launch-inputs.json`, { browser: state.report.browser,
          ...(engine === 'webdriverio' ? { driver: { sha256: state.report.driver.sha256, versionOutput: state.report.driver.versionOutput } } : {}) });
        await write(`${root}/stdout.txt`, state.report);
        await write(`${root}/stderr.txt`, 'Synthetic verifier fixture; no browser launched.\n');
        if (engine === 'webdriverio') await write(`${root}/chromedriver.log`, '');
      }
      await write(`${root}/sample.json`, state.report);
      await write(`${root}/resources.json`, state.resources);
      await write(`${root}/inputs.json`, inputs);
      state.receipt.files = {};
      for (const file of await readdir(join(directory, root))) state.receipt.files[file] = hash(await readFile(join(directory, root, file)));
      await write(`${root}/admission.json`, state.receipt);
    }
    if (sampleLibrary) {
      for (const engine of ['puppeteer', 'webdriverio']) await writeCompetitor(fixture(engine), `admission-${engine}`);
      await write('admission-progress.json', { attempts: ['puppeteer', 'webdriverio'].map(engine => ({ engine, status: 'passed' })) });
    }
    for (let launchIndex = 0; launchIndex < configuration.independentLaunches; launchIndex++) for (const engine of broadLaunchOrder(launchIndex)) {
      const state = sampleLibrary && ['puppeteer', 'webdriverio'].includes(engine) ? samplingFixture(engine, launchIndex) : fixture(engine);
      state.launchIndex = launchIndex;
      if (engine === 'flashwright' || engine === 'playwright') {
        state.report.launchIndex = launchIndex;
        state.resources.command = [runtime.executable, 'benchmarks/sample.mjs', String(launchIndex), engine];
        state.report.resources = state.resources;
        await write(`launch-${launchIndex}-${engine}.json`, state.report);
        await write(`resources-${launchIndex}-${engine}.json`, state.resources);
      } else {
        await writeCompetitor(state, `launch-${launchIndex}-${engine}`);
      }
      launches[engine].push(normalizeBroadLaunch(state));
      attempts.push({ launchIndex, engine, status: 'passed' });
    }
    await write('metadata.json', metadata);
    await write('progress.json', { attempts });
    const retainedFileHashes = {};
    async function record(path = '') {
      for (const name of await readdir(join(directory, path))) {
        const relative = join(path, name);
        if ((await stat(join(directory, relative))).isDirectory()) await record(relative);
        else retainedFileHashes[relative] = hash(await readFile(join(directory, relative)));
      }
    }
    await record();
    const comparison = summarizeBroadMatrix(launches, configuration, contenders);
    const summary = { schemaVersion: 1, complete: true, valid: true, performanceLeadershipEstablished: false,
      sourceChangedDuringTiming: false, binaryChangedDuringTiming: false, dependenciesChangedDuringTiming: false, bundleChangedDuringTiming: false,
      attempts, comparison, retainedFileHashes };
    await write('summary.json', summary);
    await write('table.md', renderBroadMatrixTable(comparison));
    const verify = () => execFileSync(process.execPath, ['tools/verify-broad-matrix.mjs', directory], { encoding: 'utf8', stdio: 'pipe' });
    assert.match(verify(), /Verified 40 launches/);
    const samplePath = 'launch-0-puppeteer/sample.json';
    const original = await readFile(join(directory, samplePath), 'utf8');
    await write(samplePath, original + ' ');
    assert.throws(verify, /launch-0-puppeteer\/sample.json/);
    await write(samplePath, original);
    summary.comparison.rows[0].complete.median /= 2;
    await write('summary.json', summary);
    assert.throws(verify, /AssertionError/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
