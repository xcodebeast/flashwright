import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { verifyDriverComparisonCore } from './driver-comparison-contract.mjs';
import { comparePaired, quantile } from '../benchmarks/statistics.mjs';
import { verifyLaunch } from '../benchmarks/paired-contract.mjs';
import { verifyObservedResources } from '../benchmarks/resident-load-contract.mjs';

const directory = process.argv[2];
assert.ok(directory, 'Pass a retained driver comparison directory');
const read = async name => JSON.parse(await readFile(join(directory, name), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = await read('metadata.json');
const summary = await read('summary.json');
assert.equal(metadata.kind, 'paired-driver-comparison');
assert.equal(metadata.schemaVersion, 1);
assert.equal(summary.valid, true);
assert.equal(summary.complete, true);
assert.equal(summary.unexpectedFailures, 0);
assert.equal(summary.sourceChangedDuringTiming, false);
assert.equal(summary.browserChangedDuringTiming, false);
assert.deepEqual(summary.driversChangedDuringTiming, { reference: false, candidate: false });
assert.notEqual(metadata.drivers.reference.sha256, metadata.drivers.candidate.sha256);
assert.equal(metadata.configuration.workers, 1);
const requiredFiles = ['metadata.json', 'configuration.json', 'launch-policy.json'];
for (const [retainedName, sourceName, expected] of [
  ['configuration.json', 'benchmarks/configurations/baseline.json', metadata.configuration],
  ['launch-policy.json', 'crates/flashwright-browser/src/chromium-launch-policy.json', metadata.browser.launchPolicy],
]) {
  const bytes = await readFile(join(directory, retainedName));
  assert.equal(hash(bytes), metadata.sources[sourceName]);
  assert.deepEqual(JSON.parse(bytes), expected);
}
const launches = { reference: [], candidate: [] };
for (const variant of Object.keys(launches)) {
  const verification = metadata.verification[variant];
  assert.equal(verification.path, `verification/${variant}/report.json`);
  const bytes = await readFile(join(directory, verification.path));
  assert.equal(hash(bytes), verification.sha256);
  const report = JSON.parse(bytes);
  verifyDriverComparisonCore(report, metadata, variant);
  requiredFiles.push(verification.path);
  for (const check of report.checks) {
    const name = join(dirname(verification.path), check.log);
    assert.equal(hash(await readFile(join(directory, name))), check.logSha256);
    requiredFiles.push(name);
  }
  for (let index = 0; index < metadata.configuration.independentLaunches; index++) {
    const launchName = `${variant}/launch-${index}-flashwright.json`;
    const resourceName = `${variant}/resources-${index}-flashwright.json`;
    const launch = await read(launchName);
    assert.equal(launch.engine, 'flashwright');
    assert.equal(launch.launchIndex, index);
    assert.deepEqual(launch.engineConfiguration, metadata.engineConfiguration);
    assert.deepEqual(launch.contractFailures, []);
    assert.deepEqual(launch.resources, await read(resourceName));
    verifyLaunch(launch, metadata.configuration, metadata.browser.launchPolicy, metadata.browser.executablePath);
    verifyObservedResources(launch.resources);
    launches[variant].push(launch);
    requiredFiles.push(launchName, resourceName);
  }
}
assert.deepEqual(Object.keys(summary.retainedFileHashes).sort(), requiredFiles.sort());
for (const name of requiredFiles) assert.equal(hash(await readFile(join(directory, name))), summary.retainedFileHashes[name], name);
const compare = extract => comparePaired(launches.reference.map(extract), launches.candidate.map(extract), metadata.configuration.statistics);
for (const name of metadata.configuration.workloads) {
  assert.deepEqual(summary.workloads[name].operation, compare(launch => launch.workloads.find(workload => workload.name === name).samples.map(sample => sample.milliseconds)));
  assert.deepEqual(summary.workloads[name].preparationInclusive, compare(launch => [launch.workloads.find(workload => workload.name === name).completeMilliseconds]));
}
assert.deepEqual(summary.completeLaunch, compare(launch => [launch.completeMilliseconds]));
assert.deepEqual(summary.processWall, compare(launch => [launch.processWallMilliseconds]));
assert.deepEqual(summary.coldLaunch, compare(launch => [launch.launchMilliseconds]));
for (const [variant, records] of Object.entries(launches)) {
  assert.deepEqual(summary.resources[variant], {
    maximumSampledConcurrentRssBytes: Math.max(...records.map(record => record.resources.maximumSampledConcurrentRssBytes)),
    medianLaunchPeakRssBytes: quantile(records.map(record => record.resources.maximumSampledConcurrentRssBytes), 0.5),
    sampledCpuSeconds: records.map(record => record.resources.observedCpuSeconds),
  });
}
console.log(`Verified ${metadata.configuration.independentLaunches * 2} driver launches, distinct matching binaries, shared execution sources, copied conformance, raw resources and recomputed statistics.`);
