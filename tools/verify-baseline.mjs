import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const directory = process.argv[2];
assert(directory, 'Pass a retained benchmark result directory.');
const files = await readdir(directory);
assert(!files.includes('invalidated.json'), 'This run was explicitly invalidated.');
const metadata = JSON.parse(await readFile(path.join(directory, 'metadata.json'), 'utf8'));
const summary = JSON.parse(await readFile(path.join(directory, 'summary.json'), 'utf8'));
const { configuration } = metadata;
assert.equal(summary.unexpectedFailures, 0);
assert.equal(summary.complete, true);
for (let index = 0; index < configuration.independentLaunches; index++) {
  const launch = JSON.parse(await readFile(path.join(directory, `launch-${index}.json`), 'utf8'));
  assert.equal(launch.browserVersion, configuration.browserVersion);
  assert.equal(launch.processExit.code, 0);
  assert.equal(launch.failures.length, 0);
  assert.equal(launch.workloads.length, configuration.workloads.length);
  for (const workload of launch.workloads) {
    assert.equal(workload.failures.length, 0);
    assert.equal(workload.samples.length, configuration.measuredIterations);
    assert.equal(workload.warmupSamples.length, configuration.warmupIterations);
    assert(workload.samples.every(sample => Number.isFinite(sample.milliseconds) && sample.milliseconds > 0));
    assert(workload.completeMilliseconds >= workload.preparationMilliseconds + workload.samples.reduce((total, sample) => total + sample.milliseconds, 0));
  }
  assert.equal(launch.backend.backendRequests, configuration.measuredIterations + configuration.warmupIterations);
}
console.log(`Verified all retained samples and backend request counts: ${directory}`);
