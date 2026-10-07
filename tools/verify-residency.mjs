import assert from 'node:assert/strict';
import { requireVerifiedBrowser } from './browser-identity.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { comparePaired, quantile } from '../benchmarks/statistics.mjs';
import { verifyLaunch } from '../benchmarks/paired-contract.mjs';

const directory = process.argv[2];
assert.ok(directory, 'Pass a retained residency comparison directory');
const read = async name => JSON.parse(await readFile(join(directory, name), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = await read('metadata.json');
const summary = await read('summary.json');
assert.equal(metadata.kind, 'resident-assertion-off-on');
assert.equal(summary.valid, true);
assert.equal(summary.complete, true);
assert.equal(summary.unexpectedFailures, 0);
for (const name of ['sourceChangedDuringTiming', 'driverChangedDuringTiming', 'browserChangedDuringTiming']) assert.equal(summary[name], false);
assert.deepEqual(metadata.modes, { off: { residentAssertions: false, conditionInstrumentation: false }, on: { residentAssertions: true, conditionInstrumentation: false } });
const requiredFiles = ['metadata.json'];
const launches = { off: [], on: [] };
for (const mode of Object.keys(launches)) {
  const verification = metadata.verification[mode];
  const bytes = await readFile(verification.path);
  assert.equal(hash(bytes), verification.sha256);
  const report = JSON.parse(bytes);
  assert.equal(report.status, 'passed');
  // Historical snapshots predate browser binding; new producers always require it.
  if (metadata.verificationBrowserBound) requireVerifiedBrowser(report, metadata.browser);
  assert.equal(report.sourceChangedDuringVerification, false);
  assert.equal(report.driverSha256, metadata.driver.sha256);
  assert.deepEqual(report.sources, metadata.sources);
  assert.deepEqual(report.engineConfiguration, metadata.modes[mode]);
  for (const check of report.checks) {
    assert.equal(check.code, 0);
    assert.equal(hash(await readFile(join(dirname(verification.path), check.log))), check.logSha256);
  }
  for (let index = 0; index < metadata.configuration.independentLaunches; index++) {
    const launchName = `${mode}/launch-${index}-flashwright.json`;
    const resourceName = `${mode}/resources-${index}-flashwright.json`;
    requiredFiles.push(launchName, resourceName);
    const launch = await read(launchName);
    assert.equal(launch.launchIndex, index);
    assert.equal(launch.engine, 'flashwright');
    assert.deepEqual(launch.engineConfiguration, metadata.modes[mode]);
    assert.deepEqual(launch.resources, await read(resourceName));
    assert.deepEqual(launch.contractFailures, []);
    verifyLaunch(launch, metadata.configuration, metadata.browser.launchPolicy, metadata.browser.path);
    launches[mode].push(launch);
  }
}
assert.deepEqual(Object.keys(summary.retainedFileHashes).sort(), requiredFiles.sort());
for (const name of requiredFiles) assert.equal(hash(await readFile(join(directory, name))), summary.retainedFileHashes[name]);
const compare = extract => comparePaired(launches.off.map(extract), launches.on.map(extract), metadata.configuration.statistics);
for (const name of metadata.configuration.workloads) {
  assert.deepEqual(summary.workloads[name].operation, compare(launch => launch.workloads.find(workload => workload.name === name).samples.map(sample => sample.milliseconds)));
  assert.deepEqual(summary.workloads[name].preparationInclusive, compare(launch => [launch.workloads.find(workload => workload.name === name).completeMilliseconds]));
}
assert.deepEqual(summary.completeLaunch, compare(launch => [launch.completeMilliseconds]));
assert.deepEqual(summary.processWall, compare(launch => [launch.processWallMilliseconds]));
assert.deepEqual(summary.coldLaunch, compare(launch => [launch.launchMilliseconds]));
for (const mode of Object.keys(launches)) {
  assert.deepEqual(summary.resources[mode], {
    maximumSampledConcurrentRssBytes: Math.max(...launches[mode].map(record => record.resources.maximumSampledConcurrentRssBytes)),
    medianLaunchPeakRssBytes: quantile(launches[mode].map(record => record.resources.maximumSampledConcurrentRssBytes), 0.5),
    sampledCpuSeconds: launches[mode].map(record => record.resources.observedCpuSeconds),
  });
}
console.log(`Verified ${metadata.configuration.independentLaunches * 2} residency launches, mode-specific core evidence, complete workload contracts, retained hashes and recomputed statistics.`);
