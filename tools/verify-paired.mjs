import assert from 'node:assert/strict';
import { requireVerifiedBrowser } from './browser-identity.mjs';
import { readEngineConfiguration } from './engine-configuration.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { comparePaired, quantile } from '../benchmarks/statistics.mjs';
import { verifyLaunch } from '../benchmarks/paired-contract.mjs';

const directory = process.argv[2];
assert.ok(directory, 'Pass a retained paired benchmark directory');
const read = async name => JSON.parse(await readFile(join(directory, name), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = await read('metadata.json');
const summary = await read('summary.json');
assert.equal(summary.valid, true);
assert.equal(summary.complete, true);
assert.equal(summary.unexpectedFailures, 0);
for (const field of ['sourceChangedDuringTiming', 'driverChangedDuringTiming', 'browserChangedDuringTiming']) assert.equal(summary[field], false);
const verification = JSON.parse(await readFile(metadata.verification.path, 'utf8'));
assert.equal(hash(await readFile(metadata.verification.path)), metadata.verification.sha256);
assert.equal(verification.status, 'passed');
// Historical snapshots predate browser binding; new producers always require it.
if (metadata.verificationBrowserBound) requireVerifiedBrowser(verification, metadata.browser);
assert.equal(verification.driverSha256, metadata.driver.sha256);
assert.deepEqual(verification.sources, metadata.sources);
assert.deepEqual(verification.engineConfiguration ?? readEngineConfiguration({}), metadata.engineConfiguration ?? readEngineConfiguration({}));
assert.equal((metadata.engineConfiguration ?? readEngineConfiguration({})).conditionInstrumentation, false);
for (const check of verification.checks) {
  assert.equal(check.code, 0);
  assert.equal(hash(await readFile(join(dirname(metadata.verification.path), check.log))), check.logSha256);
}
const { configuration } = metadata;
const launches = { playwright: [], flashwright: [] };
const requiredFiles = ['metadata.json'];
for (let index = 0; index < configuration.independentLaunches; index++) {
  for (const engine of ['playwright', 'flashwright']) {
    const launchName = `launch-${index}-${engine}.json`;
    const resourceName = `resources-${index}-${engine}.json`;
    requiredFiles.push(launchName, resourceName);
    const launch = await read(launchName);
    assert.equal(launch.engine, engine);
    assert.equal(launch.launchIndex, index);
    assert.deepEqual(launch.resources, await read(resourceName));
    assert.deepEqual(launch.contractFailures, []);
    verifyLaunch(launch, configuration, metadata.browser.launchPolicy, metadata.browser.executablePath);
    launches[engine].push(launch);
  }
  assert.deepEqual(launches.flashwright[index].workloads.map(workload => workload.observations), launches.playwright[index].workloads.map(workload => workload.observations));
}
assert.deepEqual(Object.keys(summary.retainedFileHashes).sort(), requiredFiles.sort());
for (const name of requiredFiles) assert.equal(hash(await readFile(join(directory, name))), summary.retainedFileHashes[name], name);
const compare = extract => comparePaired(launches.playwright.map(extract), launches.flashwright.map(extract), configuration.statistics);
for (const name of configuration.workloads) {
  assert.deepEqual(summary.workloads[name].operation, compare(launch => launch.workloads.find(workload => workload.name === name).samples.map(sample => sample.milliseconds)));
  assert.deepEqual(summary.workloads[name].preparationInclusive, compare(launch => [launch.workloads.find(workload => workload.name === name).completeMilliseconds]));
}
for (const [metric, field] of [['completeLaunch', 'completeMilliseconds'], ['processWall', 'processWallMilliseconds'], ['coldLaunch', 'launchMilliseconds']]) assert.deepEqual(summary[metric], compare(launch => [launch[field]]));
for (const engine of ['playwright', 'flashwright']) {
  const peaks = launches[engine].map(launch => launch.resources.maximumSampledConcurrentRssBytes);
  assert.equal(summary.memory[engine].maximumSampledConcurrentRssBytes, Math.max(...peaks));
  assert.equal(summary.memory[engine].medianLaunchPeakRssBytes, quantile(peaks, 0.5));
}
assert.equal(summary.policy.releaseAccepted, false);
console.log(`Verified all ${configuration.independentLaunches * 2} retained launches, actual browser policy, semantic outcomes, resources, hashes and paired statistics: ${directory}`);
