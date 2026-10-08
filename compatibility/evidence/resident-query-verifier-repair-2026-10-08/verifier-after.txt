import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { residentLoadName } from '../benchmarks/execute-resident-load.mjs';
import { residentLoadPlan, summarizeResidentLoad } from '../benchmarks/resident-load-analysis.mjs';
import { verifyResidentLoad } from '../benchmarks/resident-load-contract.mjs';
import { sha256, verifyLoadCoreReport } from './resident-load-evidence.mjs';

/** Bind the recorded invocation to its scenario and versioned production purpose. */
export function verifyResidentLoadInvocation(command, entry, sampleVersion) {
  assert.ok(sampleVersion === undefined || sampleVersion === 2, 'Unknown resident load sample version');
  const expected = ['benchmarks/resident-load-sample.mjs', entry.mode, entry.scenario.workload,
    String(entry.scenario.conditionCount), String(entry.launchGroup)];
  if (sampleVersion === 2) expected.push('comparison');
  assert.equal(typeof command[0], 'string');
  assert.ok(command[0].length > 0, 'Missing sample runtime executable');
  assert.deepEqual(command.slice(1), expected);
}

/** Recheck raw samples, bundled conformance evidence, balanced orders and all reported statistics. */
export async function verifyResidentLoadDirectory(directory) {
  const read = async name => JSON.parse(await readFile(join(directory, name), 'utf8'));
  const metadata = await read('metadata.json');
  const summary = await read('summary.json');
  assert.equal(metadata.kind, 'resident-sustained-load');
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(summary.valid, true);
  assert.equal(summary.complete, true);
  assert.equal(summary.unexpectedFailures, 0);
  for (const name of ['sourceChangedDuringTiming', 'driverChangedDuringTiming', 'browserChangedDuringTiming']) assert.equal(summary[name], false);
  const configuration = await read('configuration.json');
  assert.deepEqual(metadata.configuration, configuration);
  assert.equal(configuration.workers, 1);
  assert.equal(sha256(await readFile(join(directory, 'configuration.json'))), metadata.sources['benchmarks/configurations/resident-load.json']);
  assert.deepEqual(metadata.browser.launchPolicy, await read('launch-policy.json'));
  assert.equal(sha256(await readFile(join(directory, 'launch-policy.json'))), metadata.sources['crates/flashwright-browser/src/chromium-launch-policy.json']);
  const requiredFiles = ['metadata.json', 'configuration.json', 'launch-policy.json'];
  for (const mode of ['off', 'on']) {
    const verification = metadata.verification[mode];
    assert.equal(verification.path, `verification/${mode}/report.json`);
    const bytes = await readFile(join(directory, verification.path));
    assert.equal(sha256(bytes), verification.sha256);
    const report = JSON.parse(bytes);
    verifyLoadCoreReport(report, metadata, mode === 'on');
    requiredFiles.push(verification.path);
    for (const check of report.checks) {
      const name = join(dirname(verification.path), check.log);
      assert.equal(sha256(await readFile(join(directory, name))), check.logSha256);
      requiredFiles.push(name);
    }
  }
  const plan = residentLoadPlan(configuration);
  assert.deepEqual(metadata.plan, plan);
  const launches = [];
  for (const entry of plan) {
    const name = residentLoadName(entry);
    const launchName = `launch-${name}.json`;
    const resourceName = `resources-${name}.json`;
    requiredFiles.push(launchName, resourceName);
    const launch = await read(launchName);
    for (const field of ['mode', 'scenario', 'launchGroup']) assert.deepEqual(launch[field], entry[field]);
    assert.deepEqual(launch.contractFailures, []);
    assert.deepEqual(launch.resources, await read(resourceName));
    verifyResidentLoadInvocation(launch.resources.command, entry, launch.schemaVersion);
    const raw = JSON.parse(launch.output);
    for (const [field, value] of Object.entries(raw)) assert.deepEqual(launch[field], value);
    verifyResidentLoad(launch, configuration, metadata.browser.launchPolicy, metadata.browser.executablePath);
    launches.push(launch);
  }
  assert.deepEqual(Object.keys(summary.retainedFileHashes).sort(), requiredFiles.sort());
  assert.deepEqual((await readdir(directory)).filter(name => /^(launch|resources)-/.test(name)).sort(), requiredFiles.filter(name => /^(launch|resources)-/.test(name)).sort());
  for (const name of requiredFiles) assert.equal(sha256(await readFile(join(directory, name))), summary.retainedFileHashes[name], name);
  assert.deepEqual(summary.scenarios, summarizeResidentLoad(launches, configuration));
  return { launches: launches.length, scenarios: summary.scenarios.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv[2], 'Pass a retained resident load directory');
  console.log(JSON.stringify(await verifyResidentLoadDirectory(process.argv[2])));
}
