import { runtimeMetadata, reportRuntime, javascriptRuntime } from '../tools/javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { identifyBrowser, requireVerifiedBrowser } from '../tools/browser-identity.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { sourceManifest } from '../tools/source-manifest.mjs';
import { comparePaired, quantile } from './statistics.mjs';
import { runSample } from './execute-sample.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const configuration = JSON.parse(await readFile('benchmarks/configurations/baseline.json', 'utf8'));
const launchPolicy = JSON.parse(await readFile('crates/flashwright-browser/src/chromium-launch-policy.json', 'utf8'));
const sources = await sourceManifest();
const driverPath = resolve(process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/release/flashwright-driver');
const browserIdentity = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath());
const browserPath = browserIdentity.executablePath;
assert.equal(browserIdentity.version, configuration.browserVersion);
const driverSha256 = hash(await readFile(driverPath));
const browserSha256 = hash(await readFile(browserPath));
const modes = { off: { residentAssertions: false, conditionInstrumentation: false }, on: { residentAssertions: true, conditionInstrumentation: false } };
const verification = {};
for (const [mode, variable] of Object.entries({ off: 'FLASHWRIGHT_BASELINE_VERIFICATION_REPORT', on: 'FLASHWRIGHT_VERIFICATION_REPORT' })) {
  assert.ok(process.env[variable], `Set ${variable} to the passed core report with residency ${mode}`);
  const path = resolve(process.env[variable]);
  const report = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(report.status, 'passed');
  requireVerifiedBrowser(report, browserIdentity);
  assert.equal(report.sourceChangedDuringVerification, false);
  assert.deepEqual(reportRuntime(report), javascriptRuntime);
  assert.equal(report.platform, process.platform);
  assert.equal(report.architecture, process.arch);
  assert.equal(report.driverSha256, driverSha256);
  assert.deepEqual(report.sources, sources);
  assert.deepEqual(report.engineConfiguration, modes[mode]);
  for (const check of report.checks) {
    assert.equal(check.code, 0);
    assert.equal(hash(await readFile(join(dirname(path), check.log))), check.logSha256);
  }
  verification[mode] = { path, sha256: hash(await readFile(path)) };
}
assert.equal(process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY, undefined, 'Uninstrumented residency comparison requires the ordinary browser path');
assert.equal(configuration.workers, 1);
const destination = resolve('benchmarks/results', `${new Date().toISOString().replaceAll(':', '-')}-${process.platform}-${process.arch}-residency-${randomUUID().slice(0, 8)}`);
await mkdir(destination, { recursive: true });
for (const mode of Object.keys(modes)) await mkdir(join(destination, mode));
const metadata = {
  verificationBrowserBound: true,
  kind: 'resident-assertion-off-on', configuration, sources, modes, verification,
  ...runtimeMetadata, platform: process.platform, architecture: process.arch,
  operatingSystem: os.version(), release: os.release(), cpu: os.cpus()[0]?.model,
  logicalProcessors: os.cpus().length, totalMemoryBytes: os.totalmem(), initialLoadAverage: os.loadavg(),
  driver: { path: driverPath, sha256: driverSha256 },
  browser: { ...browserIdentity, path: browserPath, launchPolicy },
  environmentClass: process.env.FLASHWRIGHT_ENVIRONMENT_CLASS ?? 'shared-native-development-host',
  scope: 'Same optimized Flashwright executable, browser policy and seven complete workloads. Alternate residency off/on order across independent launch pairs, including preparation, warmup and cleanup. No predicate counters or protocol proxy in timed runs.',
  limitations: ['Single-worker shared-host comparison; no native Linux or contention acceptance', 'Sampling observes descendants and can miss short-lived processes', 'This compares the engine with itself; it does not establish an advantage over other tools', 'Broader compatibility and the full resident-condition finish line remain open'],
};
await writeFile(join(destination, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
const launches = { off: [], on: [] };
const retainedNames = ['metadata.json'];
for (let launchIndex = 0; launchIndex < configuration.independentLaunches; launchIndex++) {
  for (const mode of launchIndex % 2 ? ['on', 'off'] : ['off', 'on']) {
    process.env.FLASHWRIGHT_RESIDENT_ASSERTIONS = mode === 'on' ? '1' : '0';
    process.env.FLASHWRIGHT_CONDITION_INSTRUMENTATION = '0';
    const result = await runSample({ launchIndex, engine: 'flashwright', destination: join(destination, mode), configuration, launchPolicy, driverPath, executablePath: browserPath });
    if (JSON.stringify(result.engineConfiguration) !== JSON.stringify(modes[mode])) result.contractFailures.push('Sample engine configuration differs from the selected mode');
    launches[mode].push(result);
    retainedNames.push(`${mode}/launch-${launchIndex}-flashwright.json`, `${mode}/resources-${launchIndex}-flashwright.json`);
    console.log(`Retained residency ${mode} ${launchIndex + 1}: ${result.contractFailures.length ? 'invalid' : 'verified'}`);
  }
}
const sourceChangedDuringTiming = JSON.stringify(sources) !== JSON.stringify(await sourceManifest());
const driverChangedDuringTiming = hash(await readFile(driverPath)) !== driverSha256;
const browserChangedDuringTiming = hash(await readFile(browserPath)) !== browserSha256;
const unexpectedFailures = Object.values(launches).flat().reduce((total, launch) => total + launch.contractFailures.length, 0);
const summary = { complete: true, sourceChangedDuringTiming, driverChangedDuringTiming, browserChangedDuringTiming, unexpectedFailures,
  valid: !sourceChangedDuringTiming && !driverChangedDuringTiming && !browserChangedDuringTiming && unexpectedFailures === 0 };
if (summary.valid) {
  const compare = extract => comparePaired(launches.off.map(extract), launches.on.map(extract), configuration.statistics);
  summary.workloads = Object.fromEntries(configuration.workloads.map(name => [name, {
    operation: compare(launch => launch.workloads.find(workload => workload.name === name).samples.map(sample => sample.milliseconds)),
    preparationInclusive: compare(launch => [launch.workloads.find(workload => workload.name === name).completeMilliseconds]),
  }]));
  summary.completeLaunch = compare(launch => [launch.completeMilliseconds]);
  summary.processWall = compare(launch => [launch.processWallMilliseconds]);
  summary.coldLaunch = compare(launch => [launch.launchMilliseconds]);
  summary.resources = Object.fromEntries(Object.entries(launches).map(([mode, records]) => [mode, {
    maximumSampledConcurrentRssBytes: Math.max(...records.map(record => record.resources.maximumSampledConcurrentRssBytes)),
    medianLaunchPeakRssBytes: quantile(records.map(record => record.resources.maximumSampledConcurrentRssBytes), 0.5),
    sampledCpuSeconds: records.map(record => record.resources.observedCpuSeconds),
  }]));
}
summary.retainedFileHashes = Object.fromEntries(await Promise.all(retainedNames.sort().map(async name => [name, hash(await readFile(join(destination, name)))])));
await writeFile(join(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ destination, valid: summary.valid, unexpectedFailures, completeLaunch: summary.completeLaunch }, null, 2));
process.exitCode = summary.valid ? 0 : 1;
