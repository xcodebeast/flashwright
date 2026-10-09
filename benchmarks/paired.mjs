import { requireBun, bunVersion } from '../tools/bun-toolchain.mjs';
import { runtimeMetadata, reportRuntime, javascriptRuntime } from '../tools/javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { identifyBrowser, requireVerifiedBrowser } from '../tools/browser-identity.mjs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { chromium } from 'playwright';
import { sourceManifest } from '../tools/source-manifest.mjs';
import { readEngineConfiguration } from '../tools/engine-configuration.mjs';
import { comparePaired, quantile } from './statistics.mjs';
import { runSample } from './execute-sample.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const configuration = JSON.parse(await readFile('benchmarks/configurations/baseline.json', 'utf8'));
const launchPolicy = JSON.parse(await readFile('crates/flashwright-browser/src/chromium-launch-policy.json', 'utf8'));
const driverPath = resolve(process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/release/flashwright-driver');
const browserIdentity = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath());
const executablePath = browserIdentity.executablePath;
assert.equal(browserIdentity.version, configuration.browserVersion);
const verificationPath = process.env.FLASHWRIGHT_VERIFICATION_REPORT;
assert.ok(verificationPath, 'Set FLASHWRIGHT_VERIFICATION_REPORT to a passed core report for these sources and this driver');
const verification = JSON.parse(await readFile(verificationPath, 'utf8'));
const sources = await sourceManifest();
const driverSha256 = hash(await readFile(driverPath));
const engineConfiguration = readEngineConfiguration();
assert.deepEqual(verification.engineConfiguration ?? readEngineConfiguration({}), engineConfiguration, 'Reverify the selected engine experiment configuration before timing');
assert.equal(engineConfiguration.conditionInstrumentation, false, 'Production timing excludes condition instrumentation');
assert.equal(verification.status, 'passed');
requireVerifiedBrowser(verification, browserIdentity);
assert.equal(verification.sourceChangedDuringVerification, false);
assert.deepEqual(reportRuntime(verification), javascriptRuntime);
assert.equal(verification.platform, process.platform);
assert.equal(verification.architecture, process.arch);
assert.deepEqual(verification.sources, sources, 'Reverify changed source files before timing');
assert.equal(verification.driverSha256, driverSha256, 'Reverify this driver before timing');
for (const check of verification.checks) {
  assert.equal(check.code, 0);
  assert.equal(hash(await readFile(join(dirname(verificationPath), check.log))), check.logSha256);
}
assert.equal(process.env.PLAYWRIGHT_LEGACY_SCREENSHOT, undefined, 'The comparison uses the default pinned screenshot launch policy');
assert.equal(configuration.workers, 1, 'This initial paired harness measures one worker at matched concurrency');

const runIdentifier = `${new Date().toISOString().replaceAll(':', '-')}-${process.platform}-${process.arch}-paired-${randomUUID().slice(0, 8)}`;
const destination = resolve('benchmarks/results', runIdentifier);
await mkdir(destination, { recursive: true });
const metadata = {
  verificationBrowserBound: true,
  schemaVersion: 1, runIdentifier, startedAt: new Date().toISOString(),
  purpose: 'Paired engineering profile of seven implemented real-Chromium flows; incomplete product compatibility and single-worker coverage do not establish an overall fastest-engine claim.',
  platform: process.platform, architecture: process.arch, operatingSystem: os.version(), release: os.release(),
  cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, totalMemoryBytes: os.totalmem(),
  ...runtimeMetadata, rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
  playwright: JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8')).version,
  typescript: JSON.parse(await readFile('node_modules/typescript/package.json', 'utf8')).version,
  packageManager: `bun@${bunVersion}`,
  packageManagerExecutable: requireBun(),
  driver: { path: driverPath, sha256: driverSha256 },
  browser: { ...browserIdentity, revision: '1223', launchPolicy },
  verification: { path: resolve(verificationPath), sha256: hash(await readFile(verificationPath)) },
  environmentClass: process.env.FLASHWRIGHT_ENVIRONMENT_CLASS ?? 'shared-native-development-host',
  containerImage: process.env.FLASHWRIGHT_CONTAINER_IMAGE ?? null,
  configuration, sources, engineConfiguration,
  instrumentation: {
    actualLaunchLogs: true, observedTrustedInput: true, backendRequestCounts: true,
    protocolCrossings: null, payloadBytes: null, residentEvaluations: null, discoveryVisits: null,
    resources: 'Each engine launch is independently sampled by the same external descendant-tree watchdog; short-lived or already-reparented children may be missed.',
    observations: 'One final untimed page evaluation per ordinary workload records native input outcomes; it remains included in workload/launch totals. Setup records completed context creations.',
    timing: 'Per-call samples include semantic verification. Complete workload/launch totals include preparation, warmup and cleanup. Process wall time also includes JavaScript runtime imports and the sampling wrapper.',
    detectionLag: 'Upper bound includes the existing post-assertion browser evaluation.',
  },
  limitations: ['Single worker; no contention sweep or native Linux release acceptance', 'Shared development host, not exclusive benchmark hardware', 'Internal protocol/evaluation accounting remains uninstrumented in these timings', 'Only the named fixtures and retained samples support conclusions; broad replacement and release gates remain open'],
};
await writeFile(join(destination, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });


const launches = { playwright: [], flashwright: [] };
for (let launchIndex = 0; launchIndex < configuration.independentLaunches; launchIndex++) {
  const order = launchIndex % 2 === 0 ? ['playwright', 'flashwright'] : ['flashwright', 'playwright'];
  for (const engine of order) {
    const result = await runSample({ launchIndex, engine, destination, configuration, launchPolicy, driverPath, executablePath });
    launches[engine].push(result);
    console.log(`Retained ${engine} launch ${launchIndex + 1}/${configuration.independentLaunches}: ${result.contractFailures.length ? 'invalid' : 'verified'}`);
  }
}
const sourceChangedDuringTiming = JSON.stringify(sources) !== JSON.stringify(await sourceManifest());
const driverChangedDuringTiming = hash(await readFile(driverPath)) !== driverSha256;
const browserChangedDuringTiming = hash(await readFile(executablePath)) !== metadata.browser.sha256;
const unexpectedFailures = Object.values(launches).flat().reduce((sum, launch) => sum + launch.contractFailures.length, 0);
const summary = { kind: 'paired-engineering-profile', complete: true, sourceChangedDuringTiming, driverChangedDuringTiming, browserChangedDuringTiming, unexpectedFailures,
  valid: !sourceChangedDuringTiming && !driverChangedDuringTiming && !browserChangedDuringTiming && unexpectedFailures === 0,
};
if (summary.valid) {
  const compare = extract => comparePaired(launches.playwright.map(extract), launches.flashwright.map(extract), configuration.statistics);
  summary.workloads = Object.fromEntries(configuration.workloads.map(name => [name, {
    operation: compare(launch => launch.workloads.find(workload => workload.name === name).samples.map(sample => sample.milliseconds)),
    preparationInclusive: compare(launch => [launch.workloads.find(workload => workload.name === name).completeMilliseconds]),
  }]));
  summary.completeLaunch = compare(launch => [launch.completeMilliseconds]);
  summary.processWall = compare(launch => [launch.processWallMilliseconds]);
  summary.coldLaunch = compare(launch => [launch.launchMilliseconds]);
  summary.memory = Object.fromEntries(Object.entries(launches).map(([engine, records]) => [engine, {
    maximumSampledConcurrentRssBytes: Math.max(...records.map(record => record.resources.maximumSampledConcurrentRssBytes)),
    medianLaunchPeakRssBytes: quantile(records.map(record => record.resources.maximumSampledConcurrentRssBytes), 0.5),
    sampledCpuSeconds: records.map(record => record.resources.observedCpuSeconds),
  }]));
  const regression = configuration.acceptance;
  summary.policy = {
    materialCompleteFlowImprovement: summary.completeLaunch.medianPairedSpeedup >= 1 / (1 - regression.minimumMaterialImprovementFraction) && summary.completeLaunch.pairedSpeedupConfidenceInterval[0] > 1,
    medianRegressionWorkloads: configuration.workloads.filter(name => summary.workloads[name].operation.medianPairedSpeedup < 1 / (1 + regression.maximumMedianRegressionFraction)),
    observedMaximumRegressionWorkloads: configuration.workloads.filter(name => summary.workloads[name].operation.observedMaximumRatio > 1 + regression.maximumObservedTailRegressionFraction),
    memoryWithinPolicy: summary.memory.flashwright.maximumSampledConcurrentRssBytes <= summary.memory.playwright.maximumSampledConcurrentRssBytes * (1 + regression.maximumConcurrentResidentMemoryRegressionFraction),
    releaseAccepted: false,
    reason: 'Engineering measurements only; compatibility, attribution, contention and native-platform release gates remain open.',
  };
}
summary.retainedFileHashes = Object.fromEntries(await Promise.all((await readdir(destination)).sort().map(async name => [name, hash(await readFile(join(destination, name)))])));
await writeFile(join(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ destination, valid: summary.valid, unexpectedFailures, completeLaunch: summary.completeLaunch, policy: summary.policy }, null, 2));
process.exitCode = summary.valid ? 0 : 1;
