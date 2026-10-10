import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import os from 'node:os';
import { requireBun, bunVersion } from '../tools/bun-toolchain.mjs';
import { identifyBrowser, requireVerifiedBrowser } from '../tools/browser-identity.mjs';
import { dependencyManifest } from '../tools/competitor-inputs.mjs';
import { readEngineConfiguration } from '../tools/engine-configuration.mjs';
import { reportRuntime } from '../tools/javascript-runtime.mjs';
import { sourceManifest } from '../tools/source-manifest.mjs';
import { broadEngines, broadLaunchOrder, normalizeBroadLaunch, renderBroadMatrixTable, summarizeBroadMatrix } from './broad-matrix-contract.mjs';
import { runSample } from './execute-sample.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const configuration = JSON.parse(await readFile('benchmarks/configurations/baseline.json', 'utf8'));
const contenders = JSON.parse(await readFile('benchmarks/configurations/competitors.json', 'utf8'));
const engines = ['flashwright', 'playwright', ...contenders.competitors.map(competitor => competitor.id).filter(engine => engine !== 'playwright')];
assert.deepEqual(engines, broadEngines);
assert.equal(configuration.workers, 1);
assert.equal(configuration.headless, true);
const arguments_ = process.argv.slice(2);
assert.ok(arguments_.every(argument => ['--plan', '--sample-library'].includes(argument)) && new Set(arguments_).size === arguments_.length, 'Usage: broad-matrix.mjs [--plan] [--sample-library]');
const sampleLibrary = arguments_.includes('--sample-library');
assert.deepEqual(configuration.artifacts, { trace: 'off', video: 'off', screenshot: 'off' });
assert.equal(contenders.referenceVersion, configuration.referenceVersion);
const plan = {
  engines, independentLaunches: configuration.independentLaunches, sampleLibrary,
  libraryFlow: ['flashwright', 'playwright', 'puppeteer', 'webdriverio'],
  runnerOutcome: ['cypress'],
  requirements: ['Passed current-source core report for the exact runtime, browser and Flashwright driver', 'Pinned isolated competitor dependencies and matching ChromeDriver/Cypress bundle', sampleLibrary ? 'Separate current-source library admission before sampling; recheck every sample outcome' : 'Functional admission on every fresh launch', 'One-worker complete work including preparation and cleanup', 'Rotated engine order; no shared-host timing until coordinated'],
  limitation: 'Outcome admission does not establish equivalent work for Puppeteer, Cypress or WebdriverIO; no ranking is emitted by this harness.',
};
if (process.argv.includes('--plan')) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
assert.equal(process.env.FLASHWRIGHT_BROAD_RUN, '1', 'Set FLASHWRIGHT_BROAD_RUN=1 only for a coordinated, uncontended measurement run');
requireBun();
assert.equal(process.versions.bun, bunVersion, `Run the coordinator with Bun ${bunVersion}`);
for (const name of ['PLAYWRIGHT_LEGACY_SCREENSHOT', 'FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY', 'FLASHWRIGHT_PROFILE_BROWSER_PATH']) assert.equal(process.env[name], undefined, `Remove ${name} from the measurement environment`);
assert.ok(process.env.FLASHWRIGHT_BROAD_RUNTIME && isAbsolute(process.env.FLASHWRIGHT_BROAD_RUNTIME), 'Set an absolute common JavaScript runtime for all engines');
const runtimePath = resolve(process.env.FLASHWRIGHT_BROAD_RUNTIME);
const runtimeVersion = execFileSync(runtimePath, ['--version'], { encoding: 'utf8' }).trim();
assert.ok(runtimeVersion, 'The selected runtime must respond to --version');
const measuredRuntime = JSON.parse(execFileSync(runtimePath, ['-e', 'process.stdout.write(JSON.stringify({name:process.versions.bun ? "bun" : "node",version:process.versions.bun ?? process.versions.node}))'], { encoding: 'utf8', timeout: 10000 }));
const driverPath = resolve(process.env.FLASHWRIGHT_DRIVER_PATH ?? '');
const browserPath = resolve(process.env.FLASHWRIGHT_BROWSER_PATH ?? '');
const verificationPath = resolve(process.env.FLASHWRIGHT_VERIFICATION_REPORT ?? '');
for (const [name, value] of [['FLASHWRIGHT_DRIVER_PATH', process.env.FLASHWRIGHT_DRIVER_PATH], ['FLASHWRIGHT_BROWSER_PATH', process.env.FLASHWRIGHT_BROWSER_PATH], ['FLASHWRIGHT_VERIFICATION_REPORT', process.env.FLASHWRIGHT_VERIFICATION_REPORT]]) assert.ok(value, `Set ${name}`);
const competitorDirectories = {
  puppeteer: resolve(process.env.FLASHWRIGHT_PUPPETEER_DIRECTORY ?? ''),
  webdriverio: resolve(process.env.FLASHWRIGHT_WEBDRIVERIO_DIRECTORY ?? ''),
  cypress: resolve(process.env.FLASHWRIGHT_CYPRESS_DIRECTORY ?? ''),
};
for (const engine of Object.keys(competitorDirectories)) assert.ok(process.env[`FLASHWRIGHT_${engine.toUpperCase()}_DIRECTORY`], `Set FLASHWRIGHT_${engine.toUpperCase()}_DIRECTORY`);
const chromeDriverPath = resolve(process.env.FLASHWRIGHT_CHROMEDRIVER_PATH ?? '');
const cypressBundle = resolve(process.env.FLASHWRIGHT_CYPRESS_BUNDLE ?? '');
assert.ok(process.env.FLASHWRIGHT_CHROMEDRIVER_PATH && process.env.FLASHWRIGHT_CYPRESS_BUNDLE);
const browser = await identifyBrowser(browserPath);
assert.equal(browser.version, configuration.browserVersion);
const sources = await sourceManifest();
const driverSha256 = hash(await readFile(driverPath));
const runtimeSha256 = hash(await readFile(runtimePath));
const browserSha256 = hash(await readFile(browserPath));
const chromeDriverSha256 = hash(await readFile(chromeDriverPath));
const competitorDependencies = Object.fromEntries(await Promise.all(Object.entries(competitorDirectories).map(async ([engine, directory]) => [engine, await dependencyManifest(directory)])));
const cypressBundleFiles = await dependencyManifest(cypressBundle, ['Contents']);
const verification = JSON.parse(await readFile(verificationPath, 'utf8'));
assert.equal(verification.status, 'passed');
assert.equal(verification.sourceChangedDuringVerification, false);
assert.deepEqual(verification.sources, sources);
assert.equal(verification.driverSha256, driverSha256);
assert.deepEqual(reportRuntime(verification), measuredRuntime, 'Reverify the selected measured runtime before timing');
assert.equal(verification.platform, process.platform);
assert.equal(verification.architecture, process.arch);
requireVerifiedBrowser(verification, browser);
assert.deepEqual(verification.engineConfiguration, readEngineConfiguration());
assert.equal(readEngineConfiguration().conditionInstrumentation, false);
const launchPolicy = JSON.parse(await readFile('crates/flashwright-browser/src/chromium-launch-policy.json', 'utf8'));
const policies = { chromium: launchPolicy,
  webdriverio: JSON.parse(await readFile('benchmarks/configurations/webdriverio-launch-policy.json', 'utf8')),
  cypress: JSON.parse(await readFile('benchmarks/configurations/cypress-launch-policy.json', 'utf8')) };
for (const check of verification.checks) {
  assert.equal(check.code, 0);
  assert.equal(hash(await readFile(join(dirname(verificationPath), check.log))), check.logSha256);
}
assert.ok(verification.checks.length > 0);
const destination = resolve('benchmarks/results', `${new Date().toISOString().replaceAll(':', '-')}-${process.platform}-${process.arch}-broad-${randomUUID().slice(0, 8)}`);
await mkdir(destination, { recursive: true });
await mkdir(join(destination, 'verification'));
await writeFile(join(destination, 'verification/report.json'), await readFile(verificationPath), { flag: 'wx' });
for (const check of verification.checks) {
  assert.ok(!isAbsolute(check.log) && !check.log.split(/[\\/]/).includes('..'));
  const copy = join(destination, 'verification', check.log);
  await mkdir(dirname(copy), { recursive: true });
  await writeFile(copy, await readFile(join(dirname(verificationPath), check.log)), { flag: 'wx' });
}
const metadata = {
  schemaVersion: 1, plan, configuration, contenders, policies, engineConfiguration: readEngineConfiguration(),
  startedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
  operatingSystem: os.version(), cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, totalMemoryBytes: os.totalmem(),
  orchestrator: { runtime: 'bun', version: bunVersion }, measuredRuntime: { ...measuredRuntime, executable: runtimePath, sha256: runtimeSha256 },
  browser,
  driverSha256, chromeDriverSha256, verificationSha256: hash(await readFile(verificationPath)),
  competitorDependencies, cypressBundleFiles, sources,
  environmentClass: process.env.FLASHWRIGHT_ENVIRONMENT_CLASS ?? 'shared-native-development-host',
  limitations: ['Single worker and one host; no native Linux measurement or contention sweep', sampleLibrary ? 'Puppeteer/WebdriverIO use sampling mode after separate admission; input/failure differences and the native WebdriverIO launch policy remain' : 'Puppeteer/WebdriverIO admission probes include per-iteration persistence and extra isolation; WebdriverIO also retains verbose logging and a different launch policy', 'Cypress runner outcomes retain synthetic input, runner proxy and per-test reset; its startup interval is not isolated', 'No fastest-engine claim until equivalent runner suites and acceptance gates pass'],
};
await writeFile(join(destination, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });

async function runCompetitor(engine, launchIndex) {
  const directory = join(destination, launchIndex === undefined ? `admission-${engine}` : `launch-${launchIndex}-${engine}`);
  const runner = engine === 'cypress' ? 'tools/run-cypress-admission.mjs' : 'tools/run-competitor-admission.mjs';
  const arguments_ = [runner, directory, ...(engine === 'cypress' ? [] : [engine])];
  if (sampleLibrary && engine !== 'cypress' && launchIndex !== undefined) arguments_.push(String(launchIndex));
  const environment = {
    ...process.env,
    FLASHWRIGHT_COMPETITOR_DIRECTORY: competitorDirectories[engine],
    FLASHWRIGHT_COMPETITOR_RUNTIME: runtimePath,
    FLASHWRIGHT_BROWSER_PATH: browserPath,
    FLASHWRIGHT_CHROMEDRIVER_PATH: chromeDriverPath,
    FLASHWRIGHT_CYPRESS_BUNDLE: cypressBundle,
  };
  const child = spawn(process.execPath, arguments_, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exit = await new Promise(resolve => { child.on('error', error => resolve({ code: null, error: error.message })); child.on('close', (code, signal) => resolve({ code, signal })); });
  assert.equal(exit.code, 0, `${engine} admission failed on launch ${launchIndex}: ${stderr}\n${stdout}`);
  const read = async name => JSON.parse(await readFile(join(directory, name), 'utf8'));
  return { report: await read('sample.json'), receipt: await read('admission.json'), resources: await read('resources.json') };
}

const admissions = {};
const admissionAttempts = [];
if (sampleLibrary) for (const engine of ['puppeteer', 'webdriverio']) {
  const startedAt = new Date().toISOString();
  let failure;
  try {
    admissions[engine] = await runCompetitor(engine);
    assert.equal(admissions[engine].receipt.functionalAdmissionPassed, true);
  } catch (error) { failure = error; }
  admissionAttempts.push({ engine, startedAt, finishedAt: new Date().toISOString(), status: failure ? 'failed' : 'passed', ...(failure ? { error: failure.stack ?? String(failure) } : {}) });
  await writeFile(join(destination, 'admission-progress.json'), JSON.stringify({ attempts: admissionAttempts }, null, 2) + '\n');
  if (failure) throw failure;
}
const launches = Object.fromEntries(engines.map(engine => [engine, []]));
const attempts = [];
for (let launchIndex = 0; launchIndex < configuration.independentLaunches; launchIndex++) {
  const order = broadLaunchOrder(launchIndex);
  for (const engine of order) {
    const startedAt = new Date().toISOString();
    let error;
    try {
      let normalized;
      if (engine === 'playwright' || engine === 'flashwright') {
        const report = await runSample({ launchIndex, engine, destination, configuration, launchPolicy, driverPath, executablePath: browserPath, runtimePath });
        normalized = normalizeBroadLaunch({ engine, launchIndex, report, resources: report.resources, configuration, contenders, policies, browserPath });
      } else normalized = normalizeBroadLaunch({ engine, launchIndex, ...await runCompetitor(engine, launchIndex), admission: admissions[engine], configuration, contenders, policies, browserPath });
      launches[engine].push(normalized);
    } catch (caught) { error = caught?.stack ?? String(caught); }
    attempts.push({ launchIndex, engine, startedAt, finishedAt: new Date().toISOString(), status: error ? 'failed' : 'passed', ...(error ? { error } : {}) });
    await writeFile(join(destination, 'progress.json'), JSON.stringify({ attempts }, null, 2) + '\n');
    console.log(`${engine} launch ${launchIndex + 1}/${configuration.independentLaunches}: ${error ? 'failed' : 'admitted'}`);
  }
}
const sourceChangedDuringTiming = JSON.stringify(sources) !== JSON.stringify(await sourceManifest());
const binaryChangedDuringTiming = hash(await readFile(driverPath)) !== driverSha256 || hash(await readFile(browserPath)) !== browserSha256 || hash(await readFile(runtimePath)) !== runtimeSha256 || hash(await readFile(chromeDriverPath)) !== chromeDriverSha256;
const dependenciesChangedDuringTiming = JSON.stringify(competitorDependencies) !== JSON.stringify(Object.fromEntries(await Promise.all(Object.entries(competitorDirectories).map(async ([engine, directory]) => [engine, await dependencyManifest(directory)]))));
const bundleChangedDuringTiming = JSON.stringify(cypressBundleFiles) !== JSON.stringify(await dependencyManifest(cypressBundle, ['Contents']));
const valid = attempts.every(attempt => attempt.status === 'passed') && !sourceChangedDuringTiming && !binaryChangedDuringTiming && !dependenciesChangedDuringTiming && !bundleChangedDuringTiming;
const summary = {
  schemaVersion: 1, complete: true, valid, performanceLeadershipEstablished: false,
  sourceChangedDuringTiming, binaryChangedDuringTiming, dependenciesChangedDuringTiming, bundleChangedDuringTiming, attempts,
  ...(valid ? { comparison: summarizeBroadMatrix(launches, configuration, contenders) } : {}),
};
const files = {};
async function record(path = '') {
  for (const name of (await readdir(join(destination, path))).sort()) {
    const relative = join(path, name);
    if ((await stat(join(destination, relative))).isDirectory()) await record(relative);
    else files[relative] = hash(await readFile(join(destination, relative)));
  }
}
await record();
summary.retainedFileHashes = files;
await writeFile(join(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
if (valid) await writeFile(join(destination, 'table.md'), renderBroadMatrixTable(summary.comparison), { flag: 'wx' });
if (valid) execFileSync(process.execPath, ['tools/verify-broad-matrix.mjs', destination], { stdio: 'inherit' });
console.log(JSON.stringify({ destination, valid, attempts: attempts.length, performanceLeadershipEstablished: false }, null, 2));
process.exitCode = valid ? 0 : 1;
