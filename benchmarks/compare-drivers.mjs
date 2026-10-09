import { runtimeMetadata } from '../tools/javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { identifyBrowser } from '../tools/browser-identity.mjs';
import { sourceManifest } from '../tools/source-manifest.mjs';
import { readEngineConfiguration } from '../tools/engine-configuration.mjs';
import { verifyDriverComparisonCore } from '../tools/driver-comparison-contract.mjs';
import { comparePaired, quantile } from './statistics.mjs';
import { runSample } from './execute-sample.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const configurationBytes = await readFile('benchmarks/configurations/baseline.json');
const launchPolicyBytes = await readFile('crates/flashwright-browser/src/chromium-launch-policy.json');
const configuration = JSON.parse(configurationBytes);
const launchPolicy = JSON.parse(launchPolicyBytes);
assert.equal(configuration.workers, 1);
assert.equal(process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY, undefined, 'Use the uninstrumented browser path');
const browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath());
assert.equal(browser.version, configuration.browserVersion);
const destination = resolve('benchmarks/results', `${new Date().toISOString().replaceAll(':', '-')}-${process.platform}-${process.arch}-drivers-${randomUUID().slice(0, 8)}`);
await mkdir(destination, { recursive: true });
const metadata = {
  kind: 'paired-driver-comparison', schemaVersion: 1, configuration, sources: await sourceManifest(),
  ...runtimeMetadata, platform: process.platform, architecture: process.arch,
  operatingSystem: os.version(), release: os.release(), cpu: os.cpus()[0]?.model,
  logicalProcessors: os.cpus().length, totalMemoryBytes: os.totalmem(), initialLoadAverage: os.loadavg(),
  browser: { ...browser, launchPolicy }, engineConfiguration: readEngineConfiguration(), drivers: {}, verification: {},
  scope: 'Alternate two independently verified driver binaries with identical adapter, workload, browser, configuration, artifacts and one-worker resource accounting. Include startup, preparation and cleanup; retain every attempted launch.',
  limitations: ['Shared native development host; no native Linux, worker contention or release acceptance.',
    'Backend source differences are retained in the copied core reports. This comparison does not establish superiority over another tool.',
    'Eight independent pairs support bootstrap intervals and observed maxima, not percentile tails.'],
};
const retainedNames = ['metadata.json', 'configuration.json', 'launch-policy.json'];
await writeFile(join(destination, 'configuration.json'), configurationBytes, { flag: 'wx' });
await writeFile(join(destination, 'launch-policy.json'), launchPolicyBytes, { flag: 'wx' });
for (const [variant, driverVariable, reportVariable] of [
  ['reference', 'FLASHWRIGHT_REFERENCE_DRIVER_PATH', 'FLASHWRIGHT_REFERENCE_VERIFICATION_REPORT'],
  ['candidate', 'FLASHWRIGHT_DRIVER_PATH', 'FLASHWRIGHT_VERIFICATION_REPORT'],
]) {
  assert.ok(process.env[driverVariable] && process.env[reportVariable], `Set ${driverVariable} and ${reportVariable}`);
  const driverPath = resolve(process.env[driverVariable]);
  metadata.drivers[variant] = { path: driverPath, sha256: hash(await readFile(driverPath)) };
  const reportPath = resolve(process.env[reportVariable]);
  const bytes = await readFile(reportPath);
  const report = JSON.parse(bytes);
  verifyDriverComparisonCore(report, metadata, variant);
  const retainedDirectory = `verification/${variant}`;
  await mkdir(join(destination, retainedDirectory), { recursive: true });
  const retainedReport = `${retainedDirectory}/report.json`;
  await writeFile(join(destination, retainedReport), bytes, { flag: 'wx' });
  metadata.verification[variant] = { path: retainedReport, sha256: hash(bytes) };
  retainedNames.push(retainedReport);
  for (const check of report.checks) {
    assert.equal(hash(await readFile(join(dirname(reportPath), check.log))), check.logSha256);
    const name = `${retainedDirectory}/${check.log}`;
    await copyFile(join(dirname(reportPath), check.log), join(destination, name));
    retainedNames.push(name);
  }
  await mkdir(join(destination, variant));
}
assert.notEqual(metadata.drivers.reference.sha256, metadata.drivers.candidate.sha256);
await writeFile(join(destination, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
const launches = { reference: [], candidate: [] };
for (let launchIndex = 0; launchIndex < configuration.independentLaunches; launchIndex++) {
  for (const variant of launchIndex % 2 ? ['candidate', 'reference'] : ['reference', 'candidate']) {
    const result = await runSample({ launchIndex, engine: 'flashwright', destination: join(destination, variant), configuration,
      launchPolicy, driverPath: metadata.drivers[variant].path, executablePath: browser.executablePath });
    if (JSON.stringify(result.engineConfiguration) !== JSON.stringify(metadata.engineConfiguration)) result.contractFailures.push('Driver configuration differs from verified mode');
    launches[variant].push(result);
    retainedNames.push(`${variant}/launch-${launchIndex}-flashwright.json`, `${variant}/resources-${launchIndex}-flashwright.json`);
    console.log(`Retained ${variant} launch ${launchIndex + 1}: ${result.contractFailures.length ? 'invalid' : 'verified'}`);
  }
}
const summary = {
  complete: true, sourceChangedDuringTiming: JSON.stringify(metadata.sources) !== JSON.stringify(await sourceManifest()),
  browserChangedDuringTiming: hash(await readFile(browser.executablePath)) !== browser.sha256,
  driversChangedDuringTiming: Object.fromEntries(await Promise.all(Object.entries(metadata.drivers).map(async ([variant, driver]) => [variant, hash(await readFile(driver.path)) !== driver.sha256]))),
  unexpectedFailures: Object.values(launches).flat().reduce((sum, launch) => sum + launch.contractFailures.length, 0),
};
summary.valid = !summary.sourceChangedDuringTiming && !summary.browserChangedDuringTiming && !Object.values(summary.driversChangedDuringTiming).some(Boolean) && summary.unexpectedFailures === 0;
if (summary.valid) {
  const compare = extract => comparePaired(launches.reference.map(extract), launches.candidate.map(extract), configuration.statistics);
  summary.workloads = Object.fromEntries(configuration.workloads.map(name => [name, {
    operation: compare(launch => launch.workloads.find(workload => workload.name === name).samples.map(sample => sample.milliseconds)),
    preparationInclusive: compare(launch => [launch.workloads.find(workload => workload.name === name).completeMilliseconds]),
  }]));
  summary.completeLaunch = compare(launch => [launch.completeMilliseconds]);
  summary.processWall = compare(launch => [launch.processWallMilliseconds]);
  summary.coldLaunch = compare(launch => [launch.launchMilliseconds]);
  summary.resources = Object.fromEntries(Object.entries(launches).map(([variant, records]) => [variant, {
    maximumSampledConcurrentRssBytes: Math.max(...records.map(record => record.resources.maximumSampledConcurrentRssBytes)),
    medianLaunchPeakRssBytes: quantile(records.map(record => record.resources.maximumSampledConcurrentRssBytes), 0.5),
    sampledCpuSeconds: records.map(record => record.resources.observedCpuSeconds),
  }]));
}
summary.retainedFileHashes = Object.fromEntries(await Promise.all(retainedNames.sort().map(async name => [name, hash(await readFile(join(destination, name)))])));
await writeFile(join(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ destination, valid: summary.valid, completeLaunch: summary.completeLaunch }, null, 2));
process.exitCode = summary.valid ? 0 : 1;
